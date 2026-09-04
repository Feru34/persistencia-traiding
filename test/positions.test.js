import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyLegs } from '../src/repositories/positions.repo.js';

/**
 * Cliente de PostgreSQL falso: guarda las posiciones en memoria y responde
 * al SELECT ... FOR UPDATE, para poder probar la matemática de costo
 * promedio y P&L sin levantar una base de datos.
 */
function fakeClient(initial = []) {
  const state = [...initial];
  const upserts = [];
  return {
    state,
    upserts,
    async query(sql, params) {
      if (sql.includes('SELECT')) {
        const keys = [];
        for (let i = 0; i < params.length; i += 2) keys.push(`${params[i]}:${params[i + 1]}`);
        return { rows: state.filter((r) => keys.includes(`${r.user_id}:${r.asset_id}`)) };
      }
      // INSERT ... ON CONFLICT: reconstruye las filas de 6 en 6.
      for (let i = 0; i < params.length; i += 6) {
        upserts.push({
          user_id: params[i], asset_id: params[i + 1], quantity: params[i + 2],
          avg_cost_cents: params[i + 3], realized_pnl_cents: params[i + 4], fees_paid_cents: params[i + 5],
        });
      }
      return { rowCount: params.length / 6 };
    },
  };
}

describe('posiciones', () => {
  let client;
  beforeEach(() => { client = fakeClient(); });

  test('una compra desde cero fija la cantidad y el costo', async () => {
    await applyLegs(client, [{ userId: 1, assetId: 0, quantity: 10, priceCents: 5000, feeCents: 12 }]);
    assert.deepEqual(client.upserts[0], {
      user_id: 1, asset_id: 0, quantity: 10, avg_cost_cents: 5000, realized_pnl_cents: 0, fees_paid_cents: 12,
    });
  });

  test('dos compras promedian el costo ponderado por cantidad', async () => {
    await applyLegs(client, [
      { userId: 1, assetId: 0, quantity: 10, priceCents: 5000, feeCents: 0 },
      { userId: 1, assetId: 0, quantity: 10, priceCents: 7000, feeCents: 0 },
    ]);
    const [p] = client.upserts;
    assert.equal(p.quantity, 20);
    assert.equal(p.avg_cost_cents, 6000); // (10*5000 + 10*7000) / 20
  });

  test('una venta realiza P&L contra el costo promedio sin alterarlo', async () => {
    await applyLegs(client, [
      { userId: 1, assetId: 0, quantity: 10, priceCents: 5000, feeCents: 0 },
      { userId: 1, assetId: 0, quantity: -4, priceCents: 6000, feeCents: 0 },
    ]);
    const [p] = client.upserts;
    assert.equal(p.quantity, 6);
    assert.equal(p.avg_cost_cents, 5000);
    assert.equal(p.realized_pnl_cents, 4000); // (6000 - 5000) * 4
  });

  test('parte de una posición existente en la base de datos', async () => {
    client = fakeClient([
      { user_id: 7, asset_id: 2, quantity: 100, avg_cost_cents: 1000, realized_pnl_cents: 0, fees_paid_cents: 0 },
    ]);
    await applyLegs(client, [{ userId: 7, assetId: 2, quantity: -50, priceCents: 1500, feeCents: 5 }]);
    const [p] = client.upserts;
    assert.equal(p.quantity, 50);
    assert.equal(p.realized_pnl_cents, 25_000); // (1500 - 1000) * 50
    assert.equal(p.fees_paid_cents, 5);
  });

  test('agrupa varios usuarios y activos en un solo upsert por clave', async () => {
    await applyLegs(client, [
      { userId: 1, assetId: 0, quantity: 5, priceCents: 100, feeCents: 0 },
      { userId: 2, assetId: 0, quantity: -5, priceCents: 100, feeCents: 0 },
      { userId: 1, assetId: 1, quantity: 3, priceCents: 200, feeCents: 0 },
    ]);
    assert.equal(client.upserts.length, 3);
  });

  test('una venta en corto deja cantidad negativa (el motor no valida tenencias)', async () => {
    await applyLegs(client, [{ userId: 9, assetId: 0, quantity: -10, priceCents: 5000, feeCents: 0 }]);
    assert.equal(client.upserts[0].quantity, -10);
  });
});
