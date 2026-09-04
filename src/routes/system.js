import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import persistence from '../services/persistence.js';
import engineClient from '../services/engineClient.js';
import sessionManager from '../services/sessionManager.js';
import { sessionsRepo } from '../repositories/reference.repo.js';
import reconcileService from '../services/reconcileService.js';
import { buildStatus } from '../services/statusService.js';
import { errorResponses } from './schemas.js';

const TAG = ['Operación'];
const freeObject = { type: 'object', additionalProperties: true };

export default async function systemRoutes(fastify) {
  fastify.get('/health', {
    schema: {
      tags: TAG,
      summary: 'Liveness',
      description: 'Solo confirma que el proceso está vivo. No toca la base ni el motor.',
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
          properties: { status: { type: 'string' }, uptime: { type: 'number' } },
        },
      },
    },
  }, async () => ({ status: 'ok', uptime: process.uptime() }));

  fastify.get('/ready', {
    schema: {
      tags: TAG,
      summary: 'Readiness — el check que debe usar el balanceador',
      description:
        'Comprueba la RDS y el motor. Devuelve `503` solo si la **base** no responde: '
        + 'un motor caído no deja el servicio fuera de servicio, porque las consultas y '
        + 'la persistencia siguen funcionando; solo se bloquean las órdenes nuevas.',
      response: { 200: freeObject, 503: freeObject },
    },
  }, async (_request, reply) => {
    const checks = { database: 'down', engine: 'down' };
    try {
      await pool.query('SELECT 1');
      checks.database = 'up';
    } catch (err) {
      checks.databaseError = err.message;
    }
    try {
      await engineClient.getStats();
      checks.engine = 'up';
    } catch (err) {
      checks.engineError = err.message;
    }
    const ready = checks.database === 'up';
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not-ready', checks });
  });

  fastify.get('/status', {
    schema: {
      tags: TAG,
      summary: 'Estado consolidado (para mirar, no para el balanceador)',
      description:
        'Una sola llamada con todo lo que hoy hay que buscar en `/ready`, `/metrics` y '
        + 'los logs: a qué base se está conectado de verdad (host, TLS, versión, '
        + 'migraciones aplicadas), si el motor contesta y con qué latencia, la sesión '
        + 'activa, la cola write-behind y cuánto hay guardado.\n\n'
        + '`overall`: `ok` | `degraded` (motor caído, cola saturada o lotes en dead-letter) '
        + '| `down` (la base no responde). **Siempre responde 200**: es informativo. '
        + 'El balanceador debe seguir usando `/ready`.',
      response: { 200: freeObject },
    },
  }, async () => buildStatus());

  fastify.get('/metrics', {
    schema: {
      tags: TAG,
      summary: 'Métricas operativas',
      description:
        'Estado de la cola de escritura write-behind, del pool de conexiones y de la '
        + 'configuración activa. `queueDepth` y `saturated` son los que avisan de '
        + 'backpressure; `deadLettered` cuenta lo que no se pudo escribir.',
      response: { 200: freeObject },
    },
  }, async () => ({
    persistence: persistence.metrics(),
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    session: { id: sessionManager.sessionId, startedAt: sessionManager.startedAt },
    config: {
      persistMode: config.persist.mode,
      batchSize: config.persist.batchSize,
      batchIntervalMs: config.persist.intervalMs,
      feeBps: config.business.feeBps,
      engineBaseUrl: config.engine.baseUrl,
    },
  }));

  fastify.get('/engine/stats', {
    schema: {
      tags: TAG,
      summary: 'Estadísticas en vivo del motor',
      description: 'Proxy de `GET /api/estadisticas` del motor de matching.',
      response: { 200: freeObject, ...errorResponses(502) },
    },
  }, async (_request, reply) => {
    try {
      return await engineClient.getStats();
    } catch (err) {
      return reply.code(502).send({ error: 'EngineUnavailable', message: err.message });
    }
  });

  fastify.get('/engine/book', {
    schema: {
      tags: TAG,
      summary: 'Libro en vivo del motor (fuente de verdad del matching)',
      description:
        'Proxy de `GET /api/libro`. En el motor `tipo 0` es COMPRA y `tipo 1` es VENTA. '
        + 'Es el estado real contra el que reconcilia este backend.',
      response: { 200: freeObject, ...errorResponses(502) },
    },
  }, async (_request, reply) => {
    try {
      return { data: await engineClient.getBook() };
    } catch (err) {
      return reply.code(502).send({ error: 'EngineUnavailable', message: err.message });
    }
  });

  fastify.post('/engine/match', {
    schema: {
      tags: TAG,
      summary: 'Forzar un ciclo de emparejamiento',
      description: 'Útil con `matching.strategy=PERIODICO`, que empareja por lotes.',
      response: { 200: freeObject, ...errorResponses(502) },
    },
  }, async (_request, reply) => {
    try {
      return { message: await engineClient.triggerMatching() };
    } catch (err) {
      return reply.code(502).send({ error: 'EngineUnavailable', message: err.message });
    }
  });

  fastify.post('/engine/reset', {
    schema: {
      tags: TAG,
      summary: 'Reiniciar el motor y rotar la sesión',
      description:
        'Usar **esto** y no un `curl` directo al motor. El reset deja su estado en blanco; '
        + 'sin abrir una sesión nueva, los trades siguientes se asociarían a las órdenes '
        + 'de la ejecución anterior.',
      response: { 200: freeObject, ...errorResponses(502) },
    },
  }, async (_request, reply) => {
    try {
      const message = await engineClient.reset();
      const sessionId = await sessionManager.rotate('reset manual vía API');
      return { message, sessionId };
    } catch (err) {
      return reply.code(502).send({ error: 'EngineUnavailable', message: err.message });
    }
  });

  fastify.get('/sessions', {
    schema: {
      tags: TAG,
      summary: 'Sesiones del motor',
      description:
        'Una sesión por ejecución del motor, con sus conteos. Existen porque el contador '
        + 'de ids de orden del motor vuelve a 1 al reiniciar la JVM.',
      response: { 200: freeObject },
    },
  }, async () => ({ data: await sessionsRepo.list() }));

  const reconcileSchema = {
    tags: TAG,
    summary: 'Reconciliar contra el libro del motor',
    description:
      'El motor publica los emparejamientos por WebSocket **sin búfer de reenvío**: si el '
      + 'worker estaba caído, ese trade se perdió para siempre. Esto compara nuestras '
      + 'órdenes con `GET /api/libro` y detecta la deriva.\n\n'
      + '`GET` solo informa. `POST ?repair=true` corrige las cantidades ejecutadas.\n\n'
      + '**Límite deliberado:** repara el estado de las *órdenes*, pero no inventa trades. '
      + 'El motor no dice contra quién se emparejó cada orden, así que un trade perdido no '
      + 'se puede reconstruir y las posiciones y saldos quedan incompletos para ese '
      + 'volumen. `unaccountedQuantity` cuantifica esa brecha.',
    response: { 200: freeObject, ...errorResponses(502) },
  };

  fastify.get('/admin/reconcile', { schema: reconcileSchema }, async (_request, reply) => {
    try {
      return await reconcileService.run({ repair: false });
    } catch (err) {
      return reply.code(502).send({ error: 'EngineUnavailable', message: err.message });
    }
  });

  fastify.post('/admin/reconcile', {
    schema: {
      ...reconcileSchema,
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { repair: { type: 'boolean', default: false, description: 'Corregir, no solo informar' } },
      },
    },
  }, async (request, reply) => {
    try {
      return await reconcileService.run({ repair: request.query.repair });
    } catch (err) {
      return reply.code(502).send({ error: 'EngineUnavailable', message: err.message });
    }
  });

  fastify.post('/admin/flush', {
    schema: {
      tags: TAG,
      summary: 'Vaciar la cola de escritura ya',
      description: 'Fuerza el flush del write-behind. Sobre todo útil en pruebas.',
      response: { 200: freeObject },
    },
  }, async () => {
    await persistence.writer.flush();
    return { flushed: true, metrics: persistence.metrics() };
  });
}
