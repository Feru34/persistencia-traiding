import orderService from '../services/orderService.js';
import tradeService from '../services/tradeService.js';
import { assetsRepo } from '../repositories/reference.repo.js';
import { toUnits } from '../domain/money.js';
import { listOf, errorResponses } from './schemas.js';

const TAG = ['Mercado'];
const assetParam = {
  type: 'object',
  properties: { assetId: { type: 'integer', minimum: 0, maximum: 4 } },
  required: ['assetId'],
};

export default async function marketRoutes(fastify) {
  fastify.get('/assets', {
    schema: {
      tags: TAG,
      summary: 'Listar los activos disponibles',
      description: 'El motor de matching solo admite `idActivo` de 0 a 4.',
      response: { 200: listOf('Asset') },
    },
  }, async () => ({ data: await assetsRepo.list() }));

  // Declarada antes que `/market/:assetId` por claridad; Fastify resuelve las
  // rutas estáticas antes que las paramétricas de todas formas.
  fastify.get('/market/summary', {
    schema: {
      tags: TAG,
      summary: 'Resumen OHLC, volumen y comisiones',
      description: 'Agrega los trades por activo. Sin `since`, cubre todo el histórico.',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          assetId: { type: 'integer', minimum: 0, maximum: 4 },
          since: { type: 'string', format: 'date-time', description: 'Inicio de la ventana, ISO-8601' },
        },
      },
      response: { 200: listOf('AssetSummary') },
    },
  }, async (request) => ({ data: await tradeService.summary(request.query) }));

  fastify.get('/market', {
    schema: {
      tags: TAG,
      summary: 'Estado de mercado de todos los activos',
      description: 'Mejor compra y venta, spread, profundidad viva y último precio negociado.',
      response: { 200: listOf('MarketState') },
    },
  }, async () => {
    const rows = await assetsRepo.marketState();
    return { data: rows.map(serializeMarket) };
  });

  fastify.get('/market/:assetId', {
    schema: {
      tags: TAG,
      summary: 'Estado de mercado de un activo',
      params: assetParam,
      response: { 200: { $ref: 'MarketState#' }, ...errorResponses(404) },
    },
  }, async (request, reply) => {
    const assetId = Number(request.params.assetId);
    const [row] = await assetsRepo.marketState(assetId);
    if (!row) return reply.code(404).send({ error: 'NotFound', message: 'Activo no encontrado' });
    return serializeMarket(row);
  });

  fastify.get('/market/:assetId/book', {
    schema: {
      tags: TAG,
      summary: 'Libro de órdenes agregado por nivel de precio',
      description:
        'Reconstruido desde la base a partir de las órdenes vivas. Para el libro **en '
        + 'vivo del motor** (la fuente de verdad del matching), usar `/engine/book`.\n\n'
        + '`bids` va de mayor a menor precio y `asks` de menor a mayor.',
      params: assetParam,
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { depth: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      },
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
          properties: {
            assetId: { type: 'integer' },
            bids: { type: 'array', items: { $ref: 'BookLevel#' }, description: 'Compras, de mayor a menor precio' },
            asks: { type: 'array', items: { $ref: 'BookLevel#' }, description: 'Ventas, de menor a mayor precio' },
          },
        },
      },
    },
  }, async (request) => orderService.book(Number(request.params.assetId), request.query.depth));
}

function serializeMarket(row) {
  return {
    assetId: Number(row.asset_id),
    symbol: row.symbol,
    name: row.name,
    bestBid: row.best_bid_cents === null ? null : toUnits(row.best_bid_cents),
    bestAsk: row.best_ask_cents === null ? null : toUnits(row.best_ask_cents),
    spread: row.spread_cents === null ? null : toUnits(row.spread_cents),
    lastPrice: row.last_price_cents === null ? null : toUnits(row.last_price_cents),
    lastTradeAt: row.last_trade_at,
    openBuyOrders: Number(row.open_buy_orders),
    openSellOrders: Number(row.open_sell_orders),
    openBuyQuantity: Number(row.open_buy_quantity),
    openSellQuantity: Number(row.open_sell_quantity),
  };
}
