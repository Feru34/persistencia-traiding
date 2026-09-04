import pg from 'pg';
import { config } from '../config/index.js';

// El motor trabaja en centavos y aquí todo dinero es BIGINT. node-postgres
// devuelve BIGINT (OID 20) como string para no perder precisión; en este
// dominio los valores caben de sobra en un Number seguro (< 2^53), así que
// los convertimos para que la API entregue números y no strings.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
// NUMERIC -> Number (solo se usa en agregados de reportes)
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));

const { Pool } = pg;

const poolConfig = config.db.connectionString
  ? {
      connectionString: config.db.connectionString,
      ssl: config.db.ssl,
    }
  : {
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      ssl: config.db.ssl,
    };

export const pool = new Pool({
  ...poolConfig,
  max: config.db.max,
  min: config.db.min,
  idleTimeoutMillis: config.db.idleTimeoutMillis,
  connectionTimeoutMillis: config.db.connectionTimeoutMillis,
  // Evita que una consulta colgada retenga una conexión del pool para siempre.
  statement_timeout: config.db.statementTimeoutMs,
  application_name: 'trading-persistence',
});

pool.on('error', (err) => {
  // Un cliente inactivo del pool murió (p. ej. failover de RDS). El pool se
  // recupera solo; solo hay que evitar que el 'error' no capturado tumbe el proceso.
  console.error('[db] error en cliente inactivo del pool:', err.message);
});

export const query = (text, params) => pool.query(text, params);

/** Ejecuta `fn` dentro de una transacción, con COMMIT/ROLLBACK automático. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // La conexión ya estaba rota; el pool la descarta.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
