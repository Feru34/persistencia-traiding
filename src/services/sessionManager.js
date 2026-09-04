import { config } from '../config/index.js';
import { withTransaction } from '../db/pool.js';
import { sessionsRepo } from '../repositories/reference.repo.js';
import { uuidv7 } from '../domain/uuid.js';
import engineClient from './engineClient.js';
import ordersRepo from '../repositories/orders.repo.js';

/**
 * El motor reinicia su contador de IDs de orden en 1 cada vez que arranca o
 * recibe POST /api/reset. Sin aislar cada ejecución, la orden #1 de hoy se
 * confundiría con la #1 de ayer y los trades se asociarían a la orden
 * equivocada. Cada ejecución del motor es una "sesión".
 */
class SessionManager {
  constructor() {
    this.sessionId = null;
    this.startedAt = null;
    this.lastProcessed = -1;
    // Mayor id de orden que el motor ha devuelto en la sesión actual. Es el
    // detector de reinicios más fino que existe: el contador del motor es
    // monótono mientras viva la JVM, así que un id ya visto solo puede
    // significar que volvió a empezar desde 1.
    this.maxEngineOrderId = 0;
    // Promesa de la rotación en curso: N peticiones concurrentes que detecten
    // el reinicio a la vez deben esperar UNA rotación, no abrir N sesiones.
    this.rotating = null;
    this.poller = null;
    this.logger = console;
  }

  get current() {
    if (!this.sessionId) throw new Error('No hay sesión de motor activa; ¿se inicializó el servicio?');
    return this.sessionId;
  }

  /**
   * Decide, al arrancar, si continuar la sesión anterior o abrir una nueva.
   *
   * Reiniciar este backend NO reinicia el motor: su libro en memoria sigue
   * vivo. Si abriéramos una sesión nueva sin más, las órdenes que quedaron
   * en el libro pasarían a ser inalcanzables y sus trades se guardarían con
   * el lado vendedor/comprador en NULL. Por eso solo se rota cuando el motor
   * realmente empezó de cero.
   */
  async init(logger = console) {
    this.logger = logger;
    const open = await sessionsRepo.current();

    let stats = null;
    try {
      stats = await engineClient.getStats();
    } catch {
      // Motor inaccesible: conservamos la sesión abierta, si la hay. Rotar a
      // ciegas sería peor, porque el motor puede seguir vivo con su libro.
    }

    if (stats === null) {
      if (open) {
        await this.#resume(open, 'motor inaccesible al arrancar; se conserva la sesión');
      } else {
        await this.rotate('arranque del backend sin sesión previa');
      }
    } else {
      const processed = Number(stats.ordenesProcesadasTotales ?? 0);
      const enBooks = Number(stats.ordenesEnCompra ?? 0) + Number(stats.ordenesEnVenta ?? 0);
      // Toda orden que registramos con id del motor fue aceptada por él, así
      // que un motor que siga siendo la misma JVM ha procesado AL MENOS esas.
      // Si lleva menos, reinició mientras este backend estaba caído.
      const recorded = open ? await ordersRepo.countInSession(open.id) : 0;
      if (open && (processed > 0 || enBooks > 0) && processed >= recorded) {
        await this.#resume(open, 'se reanuda la sesión: el motor conserva su libro');
      } else {
        let reason = 'arranque del backend';
        if (processed === 0 && enBooks === 0) reason = 'motor recién iniciado';
        else if (open && processed < recorded) {
          reason = `el motor lleva ${processed} órdenes procesadas y la sesión registra ${recorded}: reinició mientras el backend estaba caído`;
        }
        await this.rotate(reason);
      }
      this.lastProcessed = processed;
    }

    this.startPolling();
  }

  async #resume(session, reason) {
    this.sessionId = session.id;
    this.startedAt = session.started_at;
    this.maxEngineOrderId = await ordersRepo.maxEngineOrderId(session.id);
    this.logger.info?.(
      { sessionId: session.id, reason, maxEngineOrderId: this.maxEngineOrderId },
      '[session] sesión reanudada',
    );
  }

  async rotate(reason) {
    if (this.rotating) return this.rotating;
    this.rotating = (async () => {
      const id = uuidv7();
      await withTransaction(async (client) => {
        await sessionsRepo.closeOpenSessions(client);
        await sessionsRepo.open(client, { id, reason, engineUrl: config.engine.baseUrl });
      });
      this.sessionId = id;
      this.startedAt = new Date();
      this.lastProcessed = -1;
      this.maxEngineOrderId = 0;
      this.logger.info?.({ sessionId: id, reason }, '[session] nueva sesión de motor');
      return id;
    })().finally(() => { this.rotating = null; });
    return this.rotating;
  }

  /**
   * Se llama con cada id que devuelve el motor, ANTES de persistir la orden.
   * Devuelve la sesión a la que pertenece esa orden — la actual, o una nueva
   * si el id delata que el motor reinició su contador.
   *
   * Un id menor o igual que el máximo visto tiene dos causas posibles: dos
   * peticiones concurrentes cuyas respuestas llegaron desordenadas (inofensivo)
   * o un reinicio del motor. Lo decide la base: si ese id ya está registrado
   * en la sesión, es un reinicio. El desorden concurrente nunca repite un id.
   */
  async observeEngineOrderId(engineOrderId) {
    if (this.rotating) await this.rotating;
    if (engineOrderId > this.maxEngineOrderId) {
      this.maxEngineOrderId = engineOrderId;
      return this.sessionId;
    }
    // Sospecha. Dos confirmaciones exactas, sin heurísticas:
    //  1) el id ya está registrado en la sesión -> reinicio seguro;
    //  2) si no está (la sesión es joven y no había llegado a ese id), el
    //     contador acumulado del motor retrocedió respecto al último sondeo
    //     -> reinicio seguro. Un desorden concurrente nunca lo hace retroceder.
    let reason = null;
    if (await ordersRepo.engineIdExists(this.sessionId, engineOrderId)) {
      reason = 'reinicio del motor detectado: id de orden repetido en la sesión';
    } else if (this.lastProcessed >= 0) {
      try {
        const processed = Number((await engineClient.getStats()).ordenesProcesadasTotales ?? 0);
        if (processed < this.lastProcessed) {
          reason = `reinicio del motor detectado: el contador de procesadas retrocedió (${this.lastProcessed} -> ${processed})`;
        }
      } catch {
        // Sin motor no se puede confirmar; se asume desorden concurrente.
      }
    }
    if (!reason) return this.sessionId;
    this.logger.warn?.({ engineOrderId, maxSeen: this.maxEngineOrderId }, `[session] ${reason}; rotando`);
    await this.rotate(reason);
    this.maxEngineOrderId = Math.max(this.maxEngineOrderId, engineOrderId);
    return this.sessionId;
  }

  /**
   * Sondea el motor y detecta reinicios: si el contador acumulado de órdenes
   * procesadas retrocede, el motor volvió a empezar y hay que rotar la sesión.
   */
  startPolling() {
    if (config.engine.healthPollMs <= 0 || this.poller) return;
    this.poller = setInterval(async () => {
      try {
        const stats = await engineClient.getStats();
        const processed = Number(stats.ordenesProcesadasTotales ?? 0);
        if (this.lastProcessed >= 0 && processed < this.lastProcessed) {
          this.logger.warn?.(
            { antes: this.lastProcessed, ahora: processed },
            '[session] el motor se reinició (el contador retrocedió); rotando sesión',
          );
          await this.rotate('reinicio del motor detectado');
        }
        this.lastProcessed = processed;
      } catch {
        // El motor no responde: no rotamos, solo dejamos de actualizar el contador.
        // Rotar aquí crearía sesiones espurias ante un corte de red pasajero.
      }
    }, config.engine.healthPollMs);
    this.poller.unref?.();
  }

  stop() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }
}

export const sessionManager = new SessionManager();
export default sessionManager;
