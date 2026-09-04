import { pool } from '../db/pool.js';
import { valuesClause, flatten } from '../db/sqlHelpers.js';
import { OPEN_STATUSES } from '../domain/constants.js';

const COLUMNS = [
  'id', 'engine_session_id', 'engine_order_id', 'client_order_id',
  'user_id', 'asset_id', 'side', 'price_cents', 'quantity',
  'filled_quantity', 'status', 'reject_reason', 'created_at', 'accepted_at',
];

const toRow = (o) => [
  o.id, o.engineSessionId, o.engineOrderId ?? null, o.clientOrderId ?? null,
  o.userId, o.assetId, o.side, o.priceCents, o.quantity,
  o.filledQuantity ?? 0, o.status, o.rejectReason ?? null,
  o.createdAt ?? new Date(), o.acceptedAt ?? null,
];

export const ordersRepo = {
  /**
   * Inserta órdenes en lote. `ON CONFLICT DO NOTHING` hace la operación
   * idempotente: reprocesar un lote tras un fallo no duplica filas.
   */
  async insertMany(client, orders) {
    if (orders.length === 0) return { inserted: 0, replayed: 0, conflicts: [] };
    const sql = `
      INSERT INTO orders (${COLUMNS.join(', ')})
      VALUES ${valuesClause(orders.length, COLUMNS.length)}
      ON CONFLICT DO NOTHING
      RETURNING id`;
    const res = await client.query(sql, flatten(orders.map(toRow)));
    const inserted = new Set(res.rows.map((r) => r.id));
    const missing = orders.filter((o) => !inserted.has(o.id));
    if (missing.length === 0) return { inserted: inserted.size, replayed: 0, conflicts: [] };

    // `ON CONFLICT DO NOTHING` sin destino traga CUALQUIER violación de
    // unicidad, y hay dos muy distintas: el mismo `id` (un reenvío del lote,
    // benigno e intencional) y el mismo (sesión, engine_order_id) (el motor
    // reinició su contador y NO se rotó la sesión: una orden distinta que se
    // perdería sin dejar rastro). Se separan aquí para que la segunda nunca
    // pase desapercibida.
    const { rows } = await client.query(
      'SELECT id FROM orders WHERE id = ANY($1::uuid[])',
      [missing.map((o) => o.id)],
    );
    const replayed = new Set(rows.map((r) => r.id));
    const conflicts = missing.filter((o) => !replayed.has(o.id));
    return { inserted: inserted.size, replayed: replayed.size, conflicts };
  },

  /** ¿Ya se registró este id del motor en la sesión? Señal de reinicio del motor. */
  async engineIdExists(sessionId, engineOrderId) {
    const { rows } = await pool.query(
      'SELECT 1 FROM orders WHERE engine_session_id = $1 AND engine_order_id = $2 LIMIT 1',
      [sessionId, engineOrderId],
    );
    return rows.length > 0;
  },

  /** Órdenes que el motor aceptó en una sesión. Cota inferior de lo que el motor debió procesar. */
  async countInSession(sessionId) {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM orders WHERE engine_session_id = $1 AND engine_order_id IS NOT NULL',
      [sessionId],
    );
    return Number(rows[0].n);
  },

  /** Mayor id del motor registrado en una sesión (para reanudar sin perder el hilo). */
  async maxEngineOrderId(sessionId) {
    const { rows } = await pool.query(
      'SELECT COALESCE(MAX(engine_order_id), 0) AS max FROM orders WHERE engine_session_id = $1',
      [sessionId],
    );
    return Number(rows[0].max);
  },

  /**
   * Suma cantidades ejecutadas a varias órdenes en una sola sentencia y
   * recalcula el estado derivado.
   * @param {Array<{orderId: string, quantity: number}>} fills
   */
  async applyFills(client, fills) {
    if (fills.length === 0) return 0;
    // Agregamos por orden: una orden puede recibir varios fills en el lote.
    const byOrder = new Map();
    for (const f of fills) {
      byOrder.set(f.orderId, (byOrder.get(f.orderId) ?? 0) + f.quantity);
    }
    const rows = [...byOrder.entries()];
    const sql = `
      UPDATE orders o
      SET filled_quantity = LEAST(o.quantity, o.filled_quantity + f.qty),
          status = CASE
            WHEN LEAST(o.quantity, o.filled_quantity + f.qty) >= o.quantity THEN 'FILLED'::order_status
            ELSE 'PARTIALLY_FILLED'::order_status
          END,
          updated_at = now()
      FROM (VALUES ${valuesClause(rows.length, 2, 1, ['uuid', 'integer'])}) AS f(order_id, qty)
      WHERE o.id = f.order_id
        AND o.status NOT IN ('CANCELLED', 'REJECTED')`;
    const params = flatten(rows.map(([id, qty]) => [id, qty]));
    const res = await client.query(sql, params);
    return res.rowCount;
  },

  /**
   * Fija la cantidad ejecutada a un valor ABSOLUTO (no incremental).
   * Lo usa la reconciliación, que conoce el valor correcto según el motor.
   */
  async setFills(client, items) {
    if (items.length === 0) return 0;
    const sql = `
      UPDATE orders o
      SET filled_quantity = LEAST(o.quantity, f.qty),
          status = CASE
            WHEN LEAST(o.quantity, f.qty) >= o.quantity THEN 'FILLED'::order_status
            WHEN LEAST(o.quantity, f.qty) > 0 THEN 'PARTIALLY_FILLED'::order_status
            ELSE 'ACCEPTED'::order_status
          END,
          updated_at = now()
      FROM (VALUES ${valuesClause(items.length, 2, 1, ['uuid', 'integer'])}) AS f(order_id, qty)
      WHERE o.id = f.order_id
        AND o.status NOT IN ('CANCELLED', 'REJECTED')
        AND o.filled_quantity <> LEAST(o.quantity, f.qty)`;
    const res = await client.query(sql, flatten(items.map((i) => [i.orderId, i.quantity])));
    return res.rowCount;
  },

  /** Órdenes que este backend cree vivas en el libro del motor. */
  async listOpenBySession(sessionId) {
    const { rows } = await pool.query(
      `SELECT id, engine_order_id, user_id, asset_id, side, price_cents, quantity, filled_quantity, status
       FROM orders
       WHERE engine_session_id = $1
         AND engine_order_id IS NOT NULL
         AND status IN ('ACCEPTED', 'PARTIALLY_FILLED')`,
      [sessionId],
    );
    return rows;
  },

  /** Marca órdenes como aceptadas por el motor, asignando su engine_order_id. */
  async markAccepted(client, items) {
    if (items.length === 0) return 0;
    const sql = `
      UPDATE orders o
      SET engine_order_id = v.engine_order_id,
          -- Si el motor reinició entre el INSERT (PENDING) y esta confirmación,
          -- la orden pertenece a la sesión nueva, no a la que tenía la fila.
          engine_session_id = COALESCE(v.session_id, o.engine_session_id),
          status = CASE WHEN o.status = 'PENDING' THEN 'ACCEPTED'::order_status ELSE o.status END,
          accepted_at = COALESCE(o.accepted_at, now()),
          updated_at = now()
      FROM (VALUES ${valuesClause(items.length, 3, 1, ['uuid', 'bigint', 'uuid'])}) AS v(order_id, engine_order_id, session_id)
      WHERE o.id = v.order_id`;
    const res = await client.query(sql, flatten(items.map((i) => [i.orderId, i.engineOrderId, i.engineSessionId ?? null])));
    return res.rowCount;
  },

  async markRejected(client, items) {
    if (items.length === 0) return 0;
    const sql = `
      UPDATE orders o
      SET status = 'REJECTED'::order_status,
          reject_reason = v.reason,
          updated_at = now()
      FROM (VALUES ${valuesClause(items.length, 2, 1, ['uuid', 'text'])}) AS v(order_id, reason)
      WHERE o.id = v.order_id`;
    const res = await client.query(sql, flatten(items.map((i) => [i.orderId, i.reason])));
    return res.rowCount;
  },

  /**
   * Resuelve órdenes por su id del motor dentro de una sesión.
   * Es la pieza que permite reconstruir activo/usuarios de un TradeEvent,
   * que solo trae {buyOrderId, sellOrderId, precio, cantidad}.
   */
  async findByEngineIds(client, sessionId, engineOrderIds) {
    if (engineOrderIds.length === 0) return [];
    const { rows } = await client.query(
      `SELECT id, engine_order_id, user_id, asset_id, side, price_cents, quantity, filled_quantity
       FROM orders
       WHERE engine_session_id = $1 AND engine_order_id = ANY($2::bigint[])`,
      [sessionId, engineOrderIds],
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query(
      `SELECT o.*, a.symbol
       FROM orders o JOIN assets a ON a.id = o.asset_id
       WHERE o.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  },

  async findByClientOrderId(clientOrderId) {
    const { rows } = await pool.query('SELECT * FROM orders WHERE client_order_id = $1', [clientOrderId]);
    return rows[0] ?? null;
  },

  /** Listado con filtros opcionales y paginación por keyset simple. */
  async list({ userId, assetId, side, status, open, limit = 50, offset = 0 }) {
    const where = [];
    const params = [];
    const add = (clause, value) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };

    if (userId !== undefined) add('o.user_id = ?', userId);
    if (assetId !== undefined) add('o.asset_id = ?', assetId);
    if (side !== undefined) add('o.side = ?::order_side', side);
    if (status !== undefined) add('o.status = ?::order_status', status);
    if (open) where.push(`o.status = ANY('{${OPEN_STATUSES.join(',')}}'::order_status[])`);

    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT o.*, a.symbol
       FROM orders o JOIN assets a ON a.id = o.asset_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows;
  },

  async cancel(id) {
    const { rows } = await pool.query(
      `UPDATE orders SET status = 'CANCELLED'::order_status, updated_at = now()
       WHERE id = $1 AND status IN ('PENDING','ACCEPTED','PARTIALLY_FILLED')
       RETURNING *`,
      [id],
    );
    return rows[0] ?? null;
  },

  /** Libro de órdenes agregado por nivel de precio. */
  async orderBook(assetId, depth = 20) {
    const { rows } = await pool.query(
      `SELECT side, price_cents,
              SUM(remaining_quantity)::bigint AS quantity,
              COUNT(*)::bigint                AS orders
       FROM orders
       WHERE asset_id = $1 AND status IN ('ACCEPTED','PARTIALLY_FILLED') AND remaining_quantity > 0
       GROUP BY side, price_cents
       ORDER BY side, price_cents DESC`,
      [assetId],
    );
    const bids = rows.filter((r) => r.side === 'BUY')
      .sort((a, b) => b.price_cents - a.price_cents).slice(0, depth);
    const asks = rows.filter((r) => r.side === 'SELL')
      .sort((a, b) => a.price_cents - b.price_cents).slice(0, depth);
    return { bids, asks };
  },
};

export default ordersRepo;
