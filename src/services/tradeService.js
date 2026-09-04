import { uuidv7 } from '../domain/uuid.js';
import { toCents, toUnits } from '../domain/money.js';
import tradesRepo from '../repositories/trades.repo.js';
import persistence, { ITEM } from './persistence.js';
import sessionManager from './sessionManager.js';
import { ValidationError, BackpressureError } from './orderService.js';

/**
 * Normaliza un trade tal como lo emite el motor.
 *
 * El TradeEvent es literalmente {buyOrderId, sellOrderId, precio, cantidad}:
 * sin activo, sin usuarios y sin timestamp. Todo eso se reconstruye al
 * persistir cruzando contra las órdenes de la sesión.
 */
function normalize(raw, defaultSessionId) {
  const buyEngineOrderId = Number(raw.buyOrderId ?? raw.buy_order_id ?? raw.idCompra);
  const sellEngineOrderId = Number(raw.sellOrderId ?? raw.sell_order_id ?? raw.idVenta);
  const price = raw.precio ?? raw.price;
  const quantity = Number(raw.cantidad ?? raw.quantity);

  const errors = [];
  if (!Number.isInteger(buyEngineOrderId) || buyEngineOrderId < 0) errors.push('buyOrderId debe ser un entero >= 0');
  if (!Number.isInteger(sellEngineOrderId) || sellEngineOrderId < 0) errors.push('sellOrderId debe ser un entero >= 0');
  if (!(Number(price) > 0)) errors.push('precio debe ser mayor que 0');
  if (!Number.isInteger(quantity) || quantity <= 0) errors.push('cantidad debe ser un entero > 0');
  if (errors.length) throw new ValidationError('Trade inválido', errors);

  return {
    id: uuidv7(),
    engineSessionId: raw.engineSessionId ?? defaultSessionId,
    buyEngineOrderId,
    sellEngineOrderId,
    priceCents: toCents(price),
    quantity,
    // El motor no envía marca de tiempo; se usa la de ingesta salvo que el
    // worker aporte una (p. ej. el timestamp del mensaje de Kafka).
    executedAt: raw.executedAt ? new Date(raw.executedAt) : new Date(),
  };
}

export const tradeService = {
  /**
   * Ingesta de emparejamientos ejecutados. Acepta un trade o un arreglo.
   * Es idempotente: reenviar el mismo lote no duplica nada.
   */
  async ingest(body) {
    const raw = Array.isArray(body) ? body : [body];
    if (raw.length === 0) throw new ValidationError('Se esperaba al menos un trade', []);

    const sessionId = sessionManager.current;
    const trades = raw.map((t) => normalize(t, sessionId));

    const ok = await persistence.submit(trades.map((t) => ({ type: ITEM.TRADE, payload: t })));
    if (!ok) throw new BackpressureError('La cola de persistencia está saturada');

    return {
      accepted: trades.length,
      mode: persistence.isAsync() ? 'async' : 'sync',
      ids: trades.map((t) => t.id),
    };
  },

  async list(filters) {
    const rows = await tradesRepo.list(filters);
    return rows.map(serializeTrade);
  },

  async get(id) {
    const row = await tradesRepo.findById(id);
    return row ? serializeTrade(row) : null;
  },

  async summary(filters) {
    const rows = await tradesRepo.summary(filters);
    return rows.map((r) => ({
      assetId: Number(r.asset_id),
      symbol: r.symbol,
      trades: Number(r.trades),
      volume: Number(r.volume),
      notional: toUnits(r.notional_cents),
      fees: toUnits(r.fees_cents),
      open: r.open_cents === null ? null : toUnits(r.open_cents),
      high: r.high_cents === null ? null : toUnits(r.high_cents),
      low: r.low_cents === null ? null : toUnits(r.low_cents),
      close: r.close_cents === null ? null : toUnits(r.close_cents),
    }));
  },
};

export function serializeTrade(row) {
  return {
    id: row.id,
    assetId: row.asset_id === null ? null : Number(row.asset_id),
    symbol: row.symbol ?? null,
    buyOrderId: row.buy_order_id,
    sellOrderId: row.sell_order_id,
    buyEngineOrderId: Number(row.buy_engine_order_id),
    sellEngineOrderId: Number(row.sell_engine_order_id),
    buyerUserId: row.buyer_user_id === null ? null : Number(row.buyer_user_id),
    sellerUserId: row.seller_user_id === null ? null : Number(row.seller_user_id),
    price: toUnits(row.price_cents),
    quantity: Number(row.quantity),
    grossAmount: toUnits(row.gross_amount_cents),
    buyerFee: toUnits(row.buyer_fee_cents),
    sellerFee: toUnits(row.seller_fee_cents),
    executedAt: row.executed_at,
    ingestedAt: row.ingested_at,
  };
}

export default tradeService;
