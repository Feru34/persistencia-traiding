import { pool } from '../db/pool.js';
import { valuesClause, flatten } from '../db/sqlHelpers.js';

export const usersRepo = {
  /** Alta idempotente: no pisa el usuario si ya existe. */
  async ensureMany(client, users) {
    if (users.length === 0) return 0;
    const rows = users.map((u) => [u.id, u.username ?? null, u.cashBalanceCents ?? 0]);
    const res = await client.query(
      `INSERT INTO users (id, username, cash_balance_cents)
       VALUES ${valuesClause(rows.length, 3)}
       ON CONFLICT (id) DO NOTHING`,
      flatten(rows),
    );
    return res.rowCount;
  },

  async create({ id, username, cashBalanceCents = 0 }) {
    const { rows } = await pool.query(
      `INSERT INTO users (id, username, cash_balance_cents) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         username = COALESCE(EXCLUDED.username, users.username),
         updated_at = now()
       RETURNING *`,
      [id, username ?? null, cashBalanceCents],
    );
    return rows[0];
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  async list({ limit = 50, offset = 0 }) {
    const { rows } = await pool.query(
      'SELECT * FROM users ORDER BY id LIMIT $1 OFFSET $2',
      [limit, offset],
    );
    return rows;
  },

  /** Ajusta el saldo en efectivo (depósito/retiro). */
  async adjustCash(id, deltaCents) {
    const { rows } = await pool.query(
      `UPDATE users SET cash_balance_cents = cash_balance_cents + $2, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, deltaCents],
    );
    return rows[0] ?? null;
  },
};

export const assetsRepo = {
  async list() {
    const { rows } = await pool.query('SELECT * FROM assets ORDER BY id');
    return rows;
  },
  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM assets WHERE id = $1', [id]);
    return rows[0] ?? null;
  },
  async marketState(assetId) {
    const { rows } = await pool.query(
      `SELECT * FROM market_state ${assetId !== undefined ? 'WHERE asset_id = $1' : ''} ORDER BY asset_id`,
      assetId !== undefined ? [assetId] : [],
    );
    return rows;
  },
};

export const sessionsRepo = {
  async open(client, { id, reason, engineUrl }) {
    const { rows } = await client.query(
      `INSERT INTO engine_sessions (id, reason, engine_url) VALUES ($1, $2, $3) RETURNING *`,
      [id, reason, engineUrl],
    );
    return rows[0];
  },

  async closeOpenSessions(client) {
    const res = await client.query(
      `UPDATE engine_sessions SET ended_at = now() WHERE ended_at IS NULL`,
    );
    return res.rowCount;
  },

  async current() {
    const { rows } = await pool.query(
      `SELECT * FROM engine_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  },

  async list(limit = 20) {
    const { rows } = await pool.query(
      `SELECT s.*,
              (SELECT COUNT(*) FROM orders o WHERE o.engine_session_id = s.id)::bigint AS orders,
              (SELECT COUNT(*) FROM trades t WHERE t.engine_session_id = s.id)::bigint AS trades
       FROM engine_sessions s ORDER BY s.started_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  },
};

/** Aplica variaciones de saldo en efectivo a varios usuarios en una sentencia. */
usersRepo.applyCashDeltas = async function applyCashDeltas(client, deltas) {
  const entries = [...deltas.entries()].filter(([, v]) => v !== 0);
  if (entries.length === 0) return 0;
  const res = await client.query(
    `UPDATE users u
     SET cash_balance_cents = u.cash_balance_cents + v.delta, updated_at = now()
     FROM (VALUES ${valuesClause(entries.length, 2, 1, ['bigint', 'bigint'])}) AS v(user_id, delta)
     WHERE u.id = v.user_id`,
    flatten(entries.map(([id, delta]) => [id, delta])),
  );
  return res.rowCount;
};
