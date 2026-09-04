import { config } from '../config/index.js';
import { uuidv7 } from '../domain/uuid.js';
import { SIDE, ORDER_STATUS, sideToEngine } from '../domain/constants.js';
import { toCents, toUnits, hasValidPrecision } from '../domain/money.js';
import ordersRepo from '../repositories/orders.repo.js';
import positionsRepo from '../repositories/positions.repo.js';
import { usersRepo } from '../repositories/reference.repo.js';
import persistence, { ITEM } from './persistence.js';
import engineClient, { EngineError } from './engineClient.js';
import sessionManager from './sessionManager.js';

export class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.details = details;
  }
}

export class BackpressureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackpressureError';
    this.status = 503;
  }
}

function validate({ userId, assetId, side, price, quantity }) {
  const errors = [];
  if (!Number.isInteger(userId) || userId < 0) errors.push('userId debe ser un entero >= 0');
  if (!Number.isInteger(assetId) || assetId < 0 || assetId >= config.business.assetCount) {
    errors.push(`assetId debe estar entre 0 y ${config.business.assetCount - 1}`);
  }
  if (side !== SIDE.BUY && side !== SIDE.SELL) errors.push(`side debe ser "${SIDE.BUY}" o "${SIDE.SELL}"`);
  if (!(Number(price) > 0)) errors.push('price debe ser mayor que 0');
  else if (!hasValidPrecision(price)) errors.push('price admite máximo 2 decimales');
  if (!Number.isInteger(quantity) || quantity <= 0) errors.push('quantity debe ser un entero > 0');
  if (errors.length) throw new ValidationError('Orden inválida', errors);
}

/** Regla de negocio opcional: el motor NO valida saldos ni tenencias. */
async function checkBalances({ userId, assetId, side, priceCents, quantity }) {
  if (side === SIDE.SELL) {
    const positions = await positionsRepo.byUser(userId);
    const held = positions.find((p) => p.asset_id === assetId)?.quantity ?? 0;
    if (held < quantity) {
      throw new ValidationError('Fondos insuficientes', [
        `el usuario ${userId} tiene ${held} unidades del activo ${assetId} y quiere vender ${quantity}`,
      ]);
    }
  } else {
    const user = await usersRepo.findById(userId);
    const cash = user?.cash_balance_cents ?? 0;
    const needed = priceCents * quantity;
    if (cash < needed) {
      throw new ValidationError('Saldo insuficiente', [
        `el usuario ${userId} tiene ${toUnits(cash)} y la orden requiere ${toUnits(needed)}`,
      ]);
    }
  }
}

export const orderService = {
  /**
   * Registra una oferta de compra o de venta.
   *
   * Modo async (por defecto): se inyecta al motor y se responde de inmediato;
   * la fila va al escritor por lotes. La persistencia no está en el camino crítico.
   *
   * Modo sync: se persiste PENDING antes de tocar el motor y luego se confirma.
   * Cuesta dos escrituras, pero ninguna orden puede existir en el motor sin
   * haber quedado registrada antes.
   */
  async place(input) {
    validate(input);

    const { userId, assetId, side, price, quantity, clientOrderId } = input;
    const priceCents = toCents(price);

    // Idempotencia: un reintento del cliente con el mismo clientOrderId
    // devuelve la orden original en vez de duplicarla en el motor.
    if (clientOrderId) {
      const existing = await ordersRepo.findByClientOrderId(clientOrderId);
      if (existing) return { order: serialize(existing), duplicate: true };
    }

    if (config.business.enforceBalances) {
      await checkBalances({ userId, assetId, side, priceCents, quantity });
    }

    const now = new Date();
    const order = {
      id: uuidv7(),
      engineSessionId: sessionManager.current,
      engineOrderId: null,
      clientOrderId: clientOrderId ?? null,
      userId,
      assetId,
      side,
      priceCents,
      quantity,
      filledQuantity: 0,
      status: ORDER_STATUS.PENDING,
      createdAt: now,
      acceptedAt: null,
    };

    const syncMode = !persistence.isAsync();

    if (syncMode) {
      const ok = await persistence.submit([{ type: ITEM.ORDER, payload: order }]);
      if (!ok) throw new BackpressureError('La cola de persistencia está saturada');
    }

    let engineOrderId;
    try {
      engineOrderId = await engineClient.placeOrder({
        idUsuario: userId,
        idActivo: assetId,
        tipo: sideToEngine(side),
        precio: Number(price),
        cantidad: quantity,
      });
    } catch (err) {
      const reason = err instanceof EngineError ? err.message : String(err?.message ?? err);
      // La orden queda registrada como REJECTED: el rechazo también es información.
      if (syncMode) {
        await persistence.submit([{ type: ITEM.REJECTED, payload: { orderId: order.id, reason } }]);
      } else {
        persistence.submit([
          { type: ITEM.ORDER, payload: { ...order, status: ORDER_STATUS.REJECTED, rejectReason: reason } },
        ]);
      }
      throw err;
    }

    order.engineOrderId = engineOrderId;
    order.status = ORDER_STATUS.ACCEPTED;
    order.acceptedAt = new Date();

    const items = syncMode
      ? [{ type: ITEM.ACCEPTED, payload: { orderId: order.id, engineOrderId } }]
      : [{ type: ITEM.ORDER, payload: order }];

    const ok = await persistence.submit(items);
    if (!ok) throw new BackpressureError('La cola de persistencia está saturada');

    return { order: serialize(toRowShape(order)), duplicate: false };
  },

  async get(id) {
    const row = await ordersRepo.findById(id);
    return row ? serialize(row) : null;
  },

  async list(filters) {
    const rows = await ordersRepo.list(filters);
    return rows.map(serialize);
  },

  async cancel(id) {
    const row = await ordersRepo.cancel(id);
    return row ? serialize(row) : null;
  },

  async book(assetId, depth) {
    const { bids, asks } = await ordersRepo.orderBook(assetId, depth);
    const level = (r) => ({
      price: toUnits(r.price_cents),
      priceCents: Number(r.price_cents),
      quantity: Number(r.quantity),
      orders: Number(r.orders),
    });
    return { assetId, bids: bids.map(level), asks: asks.map(level) };
  },
};

/** Da a un objeto en memoria la misma forma que una fila de la BD. */
function toRowShape(o) {
  return {
    id: o.id,
    engine_session_id: o.engineSessionId,
    engine_order_id: o.engineOrderId,
    client_order_id: o.clientOrderId,
    user_id: o.userId,
    asset_id: o.assetId,
    side: o.side,
    price_cents: o.priceCents,
    quantity: o.quantity,
    filled_quantity: o.filledQuantity,
    remaining_quantity: o.quantity - o.filledQuantity,
    status: o.status,
    reject_reason: o.rejectReason ?? null,
    created_at: o.createdAt,
    accepted_at: o.acceptedAt,
    updated_at: o.createdAt,
  };
}

/** Fila de BD -> JSON público (dinero en unidades decimales). */
export function serialize(row) {
  return {
    id: row.id,
    clientOrderId: row.client_order_id,
    engineOrderId: row.engine_order_id === null ? null : Number(row.engine_order_id),
    engineSessionId: row.engine_session_id,
    userId: Number(row.user_id),
    assetId: Number(row.asset_id),
    symbol: row.symbol,
    side: row.side,
    price: toUnits(row.price_cents),
    priceCents: Number(row.price_cents),
    quantity: Number(row.quantity),
    filledQuantity: Number(row.filled_quantity),
    remainingQuantity: Number(row.remaining_quantity),
    status: row.status,
    rejectReason: row.reject_reason,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
  };
}

export default orderService;
