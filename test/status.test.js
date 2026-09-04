import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { overallStatus } from '../src/services/statusService.js';

describe('overallStatus — semáforo de GET /status', () => {
  test('down si la base no responde, aunque el motor esté bien', () => {
    assert.equal(overallStatus({ database: 'down', engine: 'up' }), 'down');
  });

  test('degraded si el motor está caído (no entran órdenes, pero se persiste)', () => {
    assert.equal(overallStatus({ database: 'up', engine: 'down' }), 'degraded');
  });

  test('degraded con la cola saturada', () => {
    assert.equal(overallStatus({ database: 'up', engine: 'up', persistence: { saturated: true } }), 'degraded');
  });

  test('degraded si hay lotes en dead-letter pendientes de reproceso', () => {
    assert.equal(overallStatus({ database: 'up', engine: 'up', persistence: { deadLettered: 3 } }), 'degraded');
  });

  test('ok cuando todo está en orden', () => {
    assert.equal(
      overallStatus({ database: 'up', engine: 'up', persistence: { saturated: false, deadLettered: 0 } }),
      'ok',
    );
  });

  test('sin métricas de persistencia se asume ok', () => {
    assert.equal(overallStatus({ database: 'up', engine: 'up' }), 'ok');
  });
});
