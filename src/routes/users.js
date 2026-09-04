import { usersRepo } from '../repositories/reference.repo.js';
import positionsRepo from '../repositories/positions.repo.js';
import { toCents, toUnits } from '../domain/money.js';
import { listOf, errorResponses } from './schemas.js';

const TAG = ['Usuarios'];
const idParam = {
  type: 'object',
  properties: { id: { type: 'integer', minimum: 0 } },
  required: ['id'],
};

export default async function usersRoutes(fastify) {
  fastify.post('/users', {
    schema: {
      tags: TAG,
      summary: 'Crear o actualizar un trader',
      description:
        'El `id` lo asigna quien llama, no la base: el motor recibe `idUsuario` como un '
        + 'entero arbitrario. Si el usuario ya existe, se actualiza el nombre.\n\n'
        + 'Con `AUTO_CREATE_USERS=true` (por defecto) no hace falta llamar aquí: el '
        + 'usuario se crea solo al registrar su primera orden, pero sin saldo.',
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'integer', minimum: 0, examples: [1] },
          username: { type: 'string', maxLength: 64, examples: ['alice'] },
          cashBalance: { type: 'number', minimum: 0, default: 0, description: 'Saldo inicial en unidades decimales' },
        },
      },
      response: { 201: { $ref: 'User#' }, ...errorResponses(400) },
    },
  }, async (request, reply) => {
    const { id, username, cashBalance = 0 } = request.body;
    const user = await usersRepo.create({ id, username, cashBalanceCents: toCents(cashBalance) });
    return reply.code(201).send(serializeUser(user));
  });

  fastify.get('/users', {
    schema: {
      tags: TAG,
      summary: 'Listar traders',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
      response: { 200: listOf('User') },
    },
  }, async (request) => ({ data: (await usersRepo.list(request.query)).map(serializeUser) }));

  fastify.get('/users/:id', {
    schema: {
      tags: TAG,
      summary: 'Consultar un trader',
      params: idParam,
      response: { 200: { $ref: 'User#' }, ...errorResponses(404) },
    },
  }, async (request, reply) => {
    const user = await usersRepo.findById(Number(request.params.id));
    if (!user) return reply.code(404).send({ error: 'NotFound', message: 'Usuario no encontrado' });
    return serializeUser(user);
  });

  fastify.post('/users/:id/cash', {
    schema: {
      tags: TAG,
      summary: 'Depositar o retirar efectivo',
      description: '`amount` positivo deposita, negativo retira.',
      params: idParam,
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['amount'],
        properties: { amount: { type: 'number', description: 'Positivo deposita, negativo retira', examples: [1000] } },
      },
      response: { 200: { $ref: 'User#' }, ...errorResponses(404) },
    },
  }, async (request, reply) => {
    const user = await usersRepo.adjustCash(Number(request.params.id), toCents(request.body.amount));
    if (!user) return reply.code(404).send({ error: 'NotFound', message: 'Usuario no encontrado' });
    return serializeUser(user);
  });

  fastify.get('/users/:id/positions', {
    schema: {
      tags: TAG,
      summary: 'Portafolio de un trader',
      description:
        'Cuántas acciones tiene de cada activo, a qué costo promedio y con qué P&L. '
        + 'El P&L no realizado se valora contra el último precio negociado.',
      params: idParam,
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
          properties: {
            userId: { type: 'integer' },
            data: { type: 'array', items: { $ref: 'Position#' } },
          },
        },
      },
    },
  }, async (request) => {
    const userId = Number(request.params.id);
    const rows = await positionsRepo.byUser(userId);
    return {
      userId,
      data: rows.map((p) => ({
        assetId: Number(p.asset_id),
        symbol: p.symbol,
        name: p.name,
        quantity: Number(p.quantity),
        avgCost: toUnits(p.avg_cost_cents),
        lastPrice: p.last_price_cents === null ? null : toUnits(p.last_price_cents),
        marketValue: toUnits(p.market_value_cents),
        unrealizedPnl: toUnits(p.unrealized_pnl_cents),
        realizedPnl: toUnits(p.realized_pnl_cents),
        feesPaid: toUnits(p.fees_paid_cents),
        updatedAt: p.updated_at,
      })),
    };
  });
}

function serializeUser(u) {
  return {
    id: Number(u.id),
    username: u.username,
    cashBalance: toUnits(u.cash_balance_cents),
    createdAt: u.created_at,
    updatedAt: u.updated_at,
  };
}
