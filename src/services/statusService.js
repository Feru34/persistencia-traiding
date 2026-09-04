import { readFileSync } from 'node:fs';
import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import persistence from './persistence.js';
import engineClient from './engineClient.js';
import sessionManager from './sessionManager.js';

/**
 * Vista consolidada de estado para `GET /api/v1/status`.
 *
 * No sustituye a `/ready` (contrato del balanceador: 503 solo si la base no
 * responde) ni a `/metrics` (detalle de la cola). Junta en una sola llamada lo
 * que hoy hay que mirar en tres sitios más los logs: a qué base estamos
 * conectados de verdad (host, TLS, versión, migraciones), si el motor
 * contesta, en qué sesión estamos, cómo va la cola y cuánto hay guardado.
 */

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const startedAt = new Date().toISOString();

/**
 * Semáforo global. Es una función pura para poder probarla sin base ni motor.
 *
 *  - `down`     : la base no responde. Nada se puede persistir.
 *  - `degraded` : la base está, pero el motor no (no entran órdenes nuevas),
 *                 la cola está saturada (se responde 503) o hay lotes en
 *                 dead-letter esperando `replay-dead-letter.js`.
 *  - `ok`       : todo lo anterior en orden.
 */
export function overallStatus({ database, engine, persistence: p = {} }) {
  if (database !== 'up') return 'down';
  if (engine !== 'up') return 'degraded';
  if (p.saturated || (p.deadLettered ?? 0) > 0) return 'degraded';
  return 'ok';
}

const DB_STATUS_SQL = `
  SELECT
    inet_server_addr()::text                              AS host,
    inet_server_port()                                     AS port,
    current_database()                                     AS database,
    current_setting('server_version')                      AS server_version,
    (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl,
    (SELECT count(*)::int FROM schema_migrations)          AS migrations_applied,
    (SELECT max(version) FROM schema_migrations)           AS last_migration,
    (SELECT count(*)::int FROM users)                      AS users,
    (SELECT count(*)::int FROM orders)                     AS orders,
    (SELECT count(*)::int FROM trades)                     AS trades,
    (SELECT count(*)::int FROM orders WHERE engine_session_id = $1) AS session_orders,
    (SELECT count(*)::int FROM trades WHERE engine_session_id = $1) AS session_trades,
    (SELECT max(ingested_at) FROM trades)                  AS last_trade_ingested_at
`;

async function checkDatabase(sessionId) {
  const t0 = performance.now();
  try {
    const { rows: [r] } = await pool.query(DB_STATUS_SQL, [sessionId]);
    return {
      status: 'up',
      latencyMs: Math.round(performance.now() - t0),
      // Con DATABASE_URL no se imprime la URL (lleva la contraseña); el host
      // real lo dice el propio servidor.
      host: r.host,
      port: r.port,
      database: r.database,
      serverVersion: r.server_version,
      ssl: r.ssl === true,
      migrations: { applied: r.migrations_applied, last: r.last_migration },
      counts: {
        users: r.users,
        orders: r.orders,
        trades: r.trades,
        sessionOrders: r.session_orders,
        sessionTrades: r.session_trades,
      },
      lastTradeIngestedAt: r.last_trade_ingested_at,
    };
  } catch (err) {
    return { status: 'down', latencyMs: Math.round(performance.now() - t0), error: err.message };
  }
}

async function checkEngine() {
  const t0 = performance.now();
  try {
    const stats = await engineClient.getStats();
    return { status: 'up', baseUrl: config.engine.baseUrl, latencyMs: Math.round(performance.now() - t0), stats };
  } catch (err) {
    return { status: 'down', baseUrl: config.engine.baseUrl, latencyMs: Math.round(performance.now() - t0), error: err.message };
  }
}

export async function buildStatus() {
  const sessionId = sessionManager.sessionId ?? null;
  const [database, engine] = await Promise.all([checkDatabase(sessionId), checkEngine()]);
  const metrics = persistence.metrics();

  return {
    overall: overallStatus({ database: database.status, engine: engine.status, persistence: metrics }),
    checkedAt: new Date().toISOString(),
    service: {
      name: pkg.name,
      version: pkg.version,
      env: config.env,
      persistMode: config.persist.mode,
      startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      pid: process.pid,
    },
    database,
    engine,
    session: { id: sessionId, startedAt: sessionManager.startedAt ?? null },
    persistence: {
      mode: metrics.mode,
      queueDepth: metrics.queueDepth,
      saturated: metrics.saturated,
      failures: metrics.failures,
      deadLettered: metrics.deadLettered,
      conflicts: metrics.conflicts,
      lastFlushAt: metrics.lastFlushAt,
    },
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
  };
}

export default { buildStatus, overallStatus };
