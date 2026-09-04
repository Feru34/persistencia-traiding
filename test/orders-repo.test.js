import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ordersRepo from '../src/repositories/orders.repo.js';

/**
 * Cliente falso: simula el INSERT ... ON CONFLICT DO NOTHING RETURNING id
 * (devuelve solo los ids que "entraron") y el SELECT que comprueba cuáles de
 * los que no entraron ya existían por su propio id.
 */
function fakeClient({ insertedIds, existingIds = [] }) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push(sql.trim().split('\n')[0]);
      if (sql.includes('INSERT INTO orders')) {
        return { rows: insertedIds.map((id) => ({ id })), rowCount: insertedIds.length };
      }
      if (sql.includes('SELECT id FROM orders WHERE id = ANY')) {
        return { rows: params[0].filter((id) => existingIds.includes(id)).map((id) => ({ id })) };
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
  };
}

const order = (id, engineOrderId) => ({
  id, engineSessionId: 'sesion-1', engineOrderId, userId: 1, assetId: 0, side: 'BUY',
  priceCents: 100, quantity: 1, status: 'ACCEPTED',
});

describe('ordersRepo.insertMany — reenvío benigno vs conflicto de id del motor', () => {
  test('todo insertado: sin consulta extra y sin conflictos', async () => {
    const c = fakeClient({ insertedIds: ['a', 'b'] });
    const r = await ordersRepo.insertMany(c, [order('a', 1), order('b', 2)]);
    assert.deepEqual(r, { inserted: 2, replayed: 0, conflicts: [] });
    assert.equal(c.calls.length, 1, 'no debe consultar existencia si nada faltó');
  });

  test('una fila no entró porque YA existía por su id: es un reenvío, no un conflicto', async () => {
    const c = fakeClient({ insertedIds: ['a'], existingIds: ['b'] });
    const r = await ordersRepo.insertMany(c, [order('a', 1), order('b', 2)]);
    assert.equal(r.inserted, 1);
    assert.equal(r.replayed, 1);
    assert.deepEqual(r.conflicts, []);
  });

  test('una fila no entró y NO existe por su id: chocó por (sesión, engine_order_id) -> conflicto', async () => {
    const c = fakeClient({ insertedIds: ['a'], existingIds: [] });
    const r = await ordersRepo.insertMany(c, [order('a', 1), order('b', 1)]);
    assert.equal(r.inserted, 1);
    assert.equal(r.replayed, 0);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].id, 'b');
    assert.equal(r.conflicts[0].engineOrderId, 1);
  });

  test('mezcla: reenvíos y conflictos se separan bien', async () => {
    const c = fakeClient({ insertedIds: [], existingIds: ['x'] });
    const r = await ordersRepo.insertMany(c, [order('x', 5), order('y', 5), order('z', 6)]);
    assert.equal(r.replayed, 1);
    assert.deepEqual(r.conflicts.map((o) => o.id), ['y', 'z']);
  });

  test('lote vacío', async () => {
    const c = fakeClient({ insertedIds: [] });
    assert.deepEqual(await ordersRepo.insertMany(c, []), { inserted: 0, replayed: 0, conflicts: [] });
    assert.equal(c.calls.length, 0);
  });
});
