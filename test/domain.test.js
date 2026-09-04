import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, toUnits, hasValidPrecision, feeCents } from '../src/domain/money.js';
import { uuidv7 } from '../src/domain/uuid.js';
import { ENGINE_SIDE, SIDE, sideToEngine, engineToSide } from '../src/domain/constants.js';

describe('money', () => {
  test('convierte precios decimales a centavos sin deriva de punto flotante', () => {
    assert.equal(toCents(100.5), 10050);
    assert.equal(toCents(0.01), 1);
    assert.equal(toCents(50.25), 5025);
    // El truncamiento de Java daría 114 aquí; redondear evita perder un centavo.
    assert.equal(toCents(1.15), 115);
    assert.equal(toCents(1.005), 100);
  });

  test('vuelve a unidades con 2 decimales', () => {
    assert.equal(toUnits(10050), 100.5);
    assert.equal(toUnits(1), 0.01);
    assert.equal(toUnits(0), 0);
  });

  test('rechaza precios con más de 2 decimales', () => {
    assert.equal(hasValidPrecision(100.5), true);
    assert.equal(hasValidPrecision(100), true);
    assert.equal(hasValidPrecision(100.55), true);
    assert.equal(hasValidPrecision(100.555), false);
  });

  test('calcula la comisión en puntos básicos redondeando hacia abajo', () => {
    assert.equal(feeCents(100_000, 25), 250);  // 0.25% de 1000.00
    assert.equal(feeCents(1, 25), 0);
    assert.equal(feeCents(0, 25), 0);
  });
});

describe('uuidv7', () => {
  test('genera la versión y la variante correctas', () => {
    const id = uuidv7();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('es monótono en el tiempo (mantiene la localidad del índice)', async () => {
    const first = uuidv7();
    await new Promise((r) => setTimeout(r, 2));
    const second = uuidv7();
    assert.ok(first < second, `${first} debería ordenar antes que ${second}`);
  });

  test('no colisiona', () => {
    const ids = new Set(Array.from({ length: 10_000 }, uuidv7));
    assert.equal(ids.size, 10_000);
  });
});

describe('contrato del motor', () => {
  test('tipo 0 es COMPRA y tipo 1 es VENTA (verificado contra el JAR)', () => {
    assert.equal(ENGINE_SIDE.BUY, 0);
    assert.equal(ENGINE_SIDE.SELL, 1);
    assert.equal(sideToEngine(SIDE.BUY), 0);
    assert.equal(sideToEngine(SIDE.SELL), 1);
    assert.equal(engineToSide(0), SIDE.BUY);
    assert.equal(engineToSide(1), SIDE.SELL);
  });
});
