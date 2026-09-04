import { config } from '../config/index.js';
import tradeService from '../services/tradeService.js';
import { listOf, errorResponses } from './schemas.js';

const TAG = ['Trades'];

export default async function tradesRoutes(fastify) {
  fastify.post('/trades', {
    schema: {
      tags: TAG,
      summary: 'Ingesta de emparejamientos ejecutados',
      description:
        'Punto por donde el worker de persistencia empuja los `TradeEvent` que emite el '
        + 'motor. Acepta **un objeto o un arreglo** (ingesta por lotes, hasta 5000).\n\n'
        + 'Es **idempotente**: un par (orden de compra, orden de venta) se empareja como '
        + 'máximo una vez, así que reenviar el mismo lote no duplica nada ni vuelve a '
        + 'mover posiciones y saldos.\n\n'
        + 'El evento del motor solo trae los dos ids de orden: el activo, los usuarios y '
        + 'las comisiones se reconstruyen aquí cruzando contra las órdenes guardadas.',
      security: config.security.ingestToken ? [{ ingestToken: [] }] : [],
      body: {
        anyOf: [
          { $ref: 'TradeIngest#' },
          { type: 'array', minItems: 1, maxItems: 5000, items: { $ref: 'TradeIngest#' } },
        ],
      },
      response: {
        202: {
          type: 'object',
          additionalProperties: true,
          description: 'Aceptado. En modo async aún no se ha escrito en la base.',
          properties: {
            accepted: { type: 'integer', description: 'Cuántos trades se admitieron' },
            mode: { type: 'string', enum: ['async', 'sync'] },
            ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
          },
        },
        ...errorResponses(400, 401, 503),
      },
    },
    preHandler: async (request, reply) => {
      const expected = config.security.ingestToken;
      if (!expected) return; // sin token configurado: abierto (solo desarrollo)
      if (request.headers['x-ingest-token'] !== expected) {
        return reply.code(401).send({ error: 'Unauthorized', message: 'X-Ingest-Token inválido' });
      }
    },
  }, async (request, reply) => reply.code(202).send(await tradeService.ingest(request.body)));

  fastify.get('/trades', {
    schema: {
      tags: TAG,
      summary: 'Listar emparejamientos',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          assetId: { type: 'integer', minimum: 0, maximum: 4 },
          userId: { type: 'integer', description: 'Trades donde el usuario compró o vendió' },
          since: { type: 'string', format: 'date-time' },
          until: { type: 'string', format: 'date-time' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
      response: { 200: listOf('Trade') },
    },
  }, async (request) => ({ data: await tradeService.list(request.query) }));

  fastify.get('/trades/:id', {
    schema: {
      tags: TAG,
      summary: 'Consultar un emparejamiento',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' } },
        required: ['id'],
      },
      response: { 200: { $ref: 'Trade#' }, ...errorResponses(404) },
    },
  }, async (request, reply) => {
    const trade = await tradeService.get(request.params.id);
    if (!trade) return reply.code(404).send({ error: 'NotFound', message: 'Trade no encontrado' });
    return trade;
  });
}
