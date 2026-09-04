import { pool } from '../db/pool.js';
import { valuesClause, flatten } from '../db/sqlHelpers.js';

const COLUMNS = [
  'id', 'engine_session_id', 'buy_engine_order_id', 'sell_engine_order_id',
  'buy_order_id', 'sell_order_id', 'asset_id', 'buyer_user_id', 'seller_user_id',
  'price_cents', 'quantity', 'buyer_fee_cents', 'seller_fee_cents', 'executed_at',
];

const toRow = (t) => [
  t.id, t.engineSessionId, t.buyEngineOrderId, t.sellEngineOrderId,
  t.buyOrderId ?? null, t.sellOrderId ?? null, t.assetId ?? null,
  t.buyerUserId ?? null, t.sellerUserId ?? null,
  t.priceCents, t.quantity, t.buyerFeeCents ?? 0, t.sellerFeeCents ?? 0,
  t.executedAt ?? new Date(),
];

export const tradesRepo = {
  /**
   * Inserta trades en lote de forma idempotente.
   *
   * El índice único (engine_session_id, buy_engine_order_id, sell_engine_order_id)
   * descarta reenvíos: un par comprador/vendedor se empareja como máximo una vez
   * en un libro con prioridad precio-tiempo.
   *
   * @returns {Promise<string[]>} ids de los trades realmente insertados
   */
  async insertMany(client, trades) {
    if (trades.length === 0) return [];
    const sql = `
      INSERT INTO trades (${COLUMNS.join(', ')})
      VALUES ${valuesClause(trades.length, COLUMNS.length)}
      ON CONFLICT (engine_session_id, buy_engine_order_id, sell_engine_order_id) DO NOTHING
      RETURNING id`;
    const res = await client.query(sql, flatten(trades.map(toRow)));
    return res.rows.map((r) => r.id);
  },

  async list({ assetId, userId, since, until, limit = 50, offset = 0 }) {
    const where = [];
    const params = [];
    const add = (clause, value) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };

    if (assetId !== undefined) add('t.asset_id = ?', assetId);
    if (userId !== undefined) {
      params.push(userId);
      where.push(`(t.buyer_user_id = $${params.length} OR t.seller_user_id = $${params.length})`);
    }
    if (since) add('t.executed_at >= ?', since);
    if (until) add('t.executed_at <= ?', until);

    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT t.*, a.symbol
       FROM trades t LEFT JOIN assets a ON a.id = t.asset_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.executed_at DESC, t.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query(
      `SELECT t.*, a.symbol FROM trades t LEFT JOIN assets a ON a.id = t.asset_id WHERE t.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  },

  /** Resumen OHLC + volumen por activo en una ventana de tiempo. */
  async summary({ assetId, since }) {
    const params = [];
    const where = [];
    if (assetId !== undefined) { params.push(assetId); where.push(`asset_id = $${params.length}`); }
    if (since) { params.push(since); where.push(`executed_at >= $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT a.id AS asset_id, a.symbol,
              COUNT(t.id)::bigint                       AS trades,
              COALESCE(SUM(t.quantity), 0)::bigint      AS volume,
              COALESCE(SUM(t.gross_amount_cents), 0)::bigint AS notional_cents,
              COALESCE(SUM(t.buyer_fee_cents + t.seller_fee_cents), 0)::bigint AS fees_cents,
              MIN(t.price_cents)                        AS low_cents,
              MAX(t.price_cents)                        AS high_cents,
              (ARRAY_AGG(t.price_cents ORDER BY t.executed_at ASC))[1]  AS open_cents,
              (ARRAY_AGG(t.price_cents ORDER BY t.executed_at DESC))[1] AS close_cents
       FROM assets a
       LEFT JOIN trades t ON t.asset_id = a.id ${where.length ? `AND ${where.join(' AND ')}` : ''}
       GROUP BY a.id, a.symbol
       ORDER BY a.id`,
      params,
    );
    return rows;
  },
};

export default tradesRepo;
