import orderService from '../services/orderService.js';
import { SIDE } from '../domain/constants.js';
import { orderBodySchema, listOf, errorResponses, SIDE_ENUM, STATUS_ENUM } from './schemas.js';

const TAG = ['Órdenes'];

const withSide = {
  ...orderBodySchema,
  required: [...orderBodySchema.required, 'side'],
  properties: {
    ...orderBodySchema.properties,
    side: { type: 'string', enum: SIDE_ENUM, description: 'BUY = compra, SELL = venta' },
  },
};

const placeResponses = {
  201: { $ref: 'Order#', description: 'Orden registrada e inyectada en el motor' },
  200: { $ref: 'Order#', description: 'Ya existía una orden con ese clientOrderId; se devuelve la original' },
  ...errorResponses(400, 502, 503),
};

export default async function ordersRoutes(fastify) {
  const place = (side) => async (request, reply) => {
    const result = await orderService.place({ ...request.body, side: side ?? request.body.side });
    return reply.code(result.duplicate ? 200 : 201).send(result.order);
  };

  fastify.post('/orders/sell', {
    schema: {
      tags: TAG,
      summary: 'Registrar una oferta de VENTA',
      description:
        'Persiste la oferta y la inyecta en el motor de matching como `tipo: 1`.\n\n'
        + 'Requisito de calidad del enunciado: debe quedar disponible para el motor en '
        + 'menos de 500 ms.',
      body: orderBodySchema,
      response: placeResponses,
    },
  }, place(SIDE.SELL));

  fastify.post('/orders/buy', {
    schema: {
      tags: TAG,
      summary: 'Registrar una oferta de COMPRA',
      description:
        'Persiste la oferta y la inyecta en el motor de matching como `tipo: 0`.\n\n'
        + 'Requisito de calidad del enunciado: debe quedar registrada y disponible para el '
        + 'motor en menos de 300 ms.',
      body: orderBodySchema,
      response: placeResponses,
    },
  }, place(SIDE.BUY));

  fastify.post('/orders', {
    schema: {
      tags: TAG,
      summary: 'Registrar una oferta indicando el lado en el cuerpo',
      description: 'Equivalente a `/orders/buy` y `/orders/sell`, con `side` como campo.',
      body: withSide,
      response: placeResponses,
    },
  }, place(null));

  fastify.get('/orders', {
    schema: {
      tags: TAG,
      summary: 'Listar órdenes',
      description: 'Todos los filtros son opcionales y se combinan con AND.',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          userId: { type: 'integer', description: 'Órdenes de un trader' },
          assetId: { type: 'integer', minimum: 0, maximum: 4 },
          side: { type: 'string', enum: SIDE_ENUM },
          status: { type: 'string', enum: STATUS_ENUM },
          open: { type: 'boolean', description: 'Solo las vivas en el libro (ACCEPTED o PARTIALLY_FILLED)' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
      response: { 200: listOf('Order') },
    },
  }, async (request) => ({ data: await orderService.list(request.query) }));

  fastify.get('/orders/:id', {
    schema: {
      tags: TAG,
      summary: 'Consultar una orden',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid', description: 'UUID de la orden' } },
        required: ['id'],
      },
      response: { 200: { $ref: 'Order#' }, ...errorResponses(404) },
    },
  }, async (request, reply) => {
    const order = await orderService.get(request.params.id);
    if (!order) return reply.code(404).send({ error: 'NotFound', message: 'Orden no encontrada' });
    return order;
  });

  fastify.delete('/orders/:id', {
    schema: {
      tags: TAG,
      summary: 'Cancelar una orden en este registro',
      description:
        '**El motor de matching no soporta cancelación.** Esto marca la orden como '
        + 'CANCELLED aquí, pero puede seguir viva en el libro en memoria del motor y '
        + 'llegar a emparejarse. La respuesta lo advierte explícitamente.',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' } },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
          description: 'La orden cancelada, más una advertencia sobre el motor',
          properties: { warning: { type: 'string' } },
        },
        ...errorResponses(409),
      },
    },
  }, async (request, reply) => {
    const order = await orderService.cancel(request.params.id);
    if (!order) {
      return reply.code(409).send({
        error: 'Conflict',
        message: 'La orden no existe o ya no se puede cancelar',
      });
    }
    return {
      ...order,
      warning: 'El motor de matching no soporta cancelación: la orden puede seguir viva en su libro en memoria.',
    };
  });
}
