import { config } from '../config/index.js';
import { withTransaction } from '../db/pool.js';
import { sessionsRepo } from '../repositories/reference.repo.js';
import { uuidv7 } from '../domain/uuid.js';
import engineClient from './engineClient.js';

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
        this.#resume(open, 'motor inaccesible al arrancar; se conserva la sesión');
      } else {
        await this.rotate('arranque del backend sin sesión previa');
      }
    } else {
      const processed = Number(stats.ordenesProcesadasTotales ?? 0);
      const enBooks = Number(stats.ordenesEnCompra ?? 0) + Number(stats.ordenesEnVenta ?? 0);
      if (open && (processed > 0 || enBooks > 0)) {
        // El motor sigue siendo el mismo de la sesión anterior.
        this.#resume(open, 'se reanuda la sesión: el motor conserva su libro');
        this.lastProcessed = processed;
      } else {
        await this.rotate(processed === 0 ? 'motor recién iniciado' : 'arranque del backend');
        this.lastProcessed = processed;
      }
    }

    this.startPolling();
  }

  #resume(session, reason) {
    this.sessionId = session.id;
    this.startedAt = session.started_at;
    this.logger.info?.({ sessionId: session.id, reason }, '[session] sesión reanudada');
  }

  async rotate(reason) {
    const id = uuidv7();
    await withTransaction(async (client) => {
      await sessionsRepo.closeOpenSessions(client);
      await sessionsRepo.open(client, { id, reason, engineUrl: config.engine.baseUrl });
    });
    this.sessionId = id;
    this.startedAt = new Date();
    this.lastProcessed = -1;
    this.logger.info?.({ sessionId: id, reason }, '[session] nueva sesión de motor');
    return id;
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
