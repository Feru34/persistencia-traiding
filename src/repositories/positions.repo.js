import { pool } from '../db/pool.js';
import { valuesClause, flatten } from '../db/sqlHelpers.js';

/**
 * Aplica el efecto de una lista de "patas" de trade sobre las posiciones.
 *
 * Estrategia: se bloquean las posiciones afectadas (SELECT ... FOR UPDATE),
 * se pliegan todas las patas del lote en memoria y se escribe el valor final
 * con un único UPSERT. Así el lote entero cuesta 2 sentencias en vez de 2 por
 * trade, y el costo promedio ponderado se calcula sobre un estado consistente.
 *
 * @param {Array<{userId, assetId, quantity, priceCents, feeCents}>} legs
 *        quantity > 0 = compra, quantity < 0 = venta
 */
export async function applyLegs(client, legs) {
  if (legs.length === 0) return 0;

  const keys = [...new Set(legs.map((l) => `${l.userId}:${l.assetId}`))].map((k) => {
    const [userId, assetId] = k.split(':');
    return { userId: Number(userId), assetId: Number(assetId) };
  });

  const { rows: existing } = await client.query(
    `SELECT user_id, asset_id, quantity, avg_cost_cents, realized_pnl_cents, fees_paid_cents
     FROM positions
     WHERE (user_id, asset_id) IN (${valuesClause(keys.length, 2, 1, ['bigint', 'integer'])})
     FOR UPDATE`,
    flatten(keys.map((k) => [k.userId, k.assetId])),
  );

  const state = new Map();
  for (const r of existing) {
    state.set(`${r.user_id}:${r.asset_id}`, {
      quantity: Number(r.quantity),
      avgCost: Number(r.avg_cost_cents),
      realized: Number(r.realized_pnl_cents),
      fees: Number(r.fees_paid_cents),
    });
  }

  for (const leg of legs) {
    const key = `${leg.userId}:${leg.assetId}`;
    const p = state.get(key) ?? { quantity: 0, avgCost: 0, realized: 0, fees: 0 };

    if (leg.quantity > 0) {
      // Compra: costo promedio ponderado.
      const newQty = p.quantity + leg.quantity;
      p.avgCost = newQty > 0
        ? Math.round((p.quantity * p.avgCost + leg.quantity * leg.priceCents) / newQty)
        : p.avgCost;
      p.quantity = newQty;
    } else {
      // Venta: realiza P&L contra el costo promedio y no lo altera.
      const sold = -leg.quantity;
      p.realized += (leg.priceCents - p.avgCost) * sold;
      p.quantity -= sold;
    }
    p.fees += leg.feeCents ?? 0;
    state.set(key, p);
  }

  const rows = [...state.entries()].map(([key, p]) => {
    const [userId, assetId] = key.split(':');
    return [Number(userId), Number(assetId), p.quantity, p.avgCost, p.realized, p.fees];
  });

  await client.query(
    `INSERT INTO positions (user_id, asset_id, quantity, avg_cost_cents, realized_pnl_cents, fees_paid_cents, updated_at)
     VALUES ${rows.map((_, i) => `($${i * 6 + 1},$${i * 6 + 2},$${i * 6 + 3},$${i * 6 + 4},$${i * 6 + 5},$${i * 6 + 6},now())`).join(',')}
     ON CONFLICT (user_id, asset_id) DO UPDATE SET
       quantity           = EXCLUDED.quantity,
       avg_cost_cents     = EXCLUDED.avg_cost_cents,
       realized_pnl_cents = EXCLUDED.realized_pnl_cents,
       fees_paid_cents    = EXCLUDED.fees_paid_cents,
       updated_at         = now()`,
    flatten(rows),
  );
  return rows.length;
}

export const positionsRepo = {
  applyLegs,

  async byUser(userId) {
    const { rows } = await pool.query(
      `SELECT p.*, a.symbol, a.name,
              m.last_price_cents,
              (p.quantity * COALESCE(m.last_price_cents, p.avg_cost_cents))::bigint AS market_value_cents,
              ((COALESCE(m.last_price_cents, p.avg_cost_cents) - p.avg_cost_cents) * p.quantity)::bigint AS unrealized_pnl_cents
       FROM positions p
       JOIN assets a ON a.id = p.asset_id
       LEFT JOIN market_state m ON m.asset_id = p.asset_id
       WHERE p.user_id = $1
       ORDER BY p.asset_id`,
      [userId],
    );
    return rows;
  },

  async byAsset(assetId, limit = 100) {
    const { rows } = await pool.query(
      `SELECT * FROM positions WHERE asset_id = $1 AND quantity <> 0
       ORDER BY quantity DESC LIMIT $2`,
      [assetId, limit],
    );
    return rows;
  },
};

export default positionsRepo;
