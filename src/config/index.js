import 'dotenv/config';

const bool = (v, def = false) => {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const int = (v, def) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

/** Traduce PGSSLMODE a la opción `ssl` que espera node-postgres. */
function buildSsl() {
  const mode = (process.env.PGSSLMODE || 'disable').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'verify') {
    // Requiere el bundle de CAs de AWS:
    // https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
    const ca = process.env.PGSSLROOTCERT;
    if (!ca) throw new Error('PGSSLMODE=verify requiere PGSSLROOTCERT con el bundle de CAs de RDS');
    return { rejectUnauthorized: true, ca };
  }
  // `require`: cifra el tránsito sin validar la cadena de certificados.
  return { rejectUnauthorized: false };
}

const persistMode = (process.env.PERSIST_MODE || 'async').toLowerCase();
if (!['async', 'sync'].includes(persistMode)) {
  throw new Error(`PERSIST_MODE inválido: "${persistMode}". Usa "async" o "sync".`);
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',

  server: {
    port: int(process.env.PORT, 3000),
    host: process.env.HOST || '0.0.0.0',
  },

  db: {
    connectionString: process.env.DATABASE_URL || undefined,
    host: process.env.PGHOST || 'localhost',
    port: int(process.env.PGPORT, 5432),
    database: process.env.PGDATABASE || 'trading',
    user: process.env.PGUSER || 'trading',
    password: process.env.PGPASSWORD || 'trading',
    ssl: buildSsl(),
    max: int(process.env.PG_POOL_MAX, 20),
    min: int(process.env.PG_POOL_MIN, 2),
    idleTimeoutMillis: int(process.env.PG_IDLE_TIMEOUT_MS, 30_000),
    connectionTimeoutMillis: int(process.env.PG_CONNECTION_TIMEOUT_MS, 5_000),
    statementTimeoutMs: int(process.env.PG_STATEMENT_TIMEOUT_MS, 10_000),
  },

  engine: {
    baseUrl: (process.env.ENGINE_BASE_URL || 'http://localhost:8080').replace(/\/+$/, ''),
    timeoutMs: int(process.env.ENGINE_TIMEOUT_MS, 2_000),
    retryAttempts: int(process.env.ENGINE_RETRY_ATTEMPTS, 2),
    retryDelayMs: int(process.env.ENGINE_RETRY_DELAY_MS, 50),
    healthPollMs: int(process.env.ENGINE_HEALTH_POLL_MS, 5_000),
  },

  persist: {
    mode: persistMode,
    batchSize: int(process.env.BATCH_SIZE, 500),
    intervalMs: int(process.env.BATCH_INTERVAL_MS, 25),
    maxQueue: int(process.env.BATCH_MAX_QUEUE, 100_000),
    retryAttempts: int(process.env.BATCH_RETRY_ATTEMPTS, 3),
    retryDelayMs: int(process.env.BATCH_RETRY_DELAY_MS, 100),
    highWatermarkPct: int(process.env.BATCH_HIGH_WATERMARK_PCT, 90),
    deadLetterPath: process.env.DEAD_LETTER_PATH || './logs/dead-letter.ndjson',
  },

  business: {
    feeBps: int(process.env.FEE_BPS, 25),
    assetCount: int(process.env.ASSET_COUNT, 5),
    autoCreateUsers: bool(process.env.AUTO_CREATE_USERS, true),
    enforceBalances: bool(process.env.ENFORCE_BALANCES, false),
  },

  security: {
    ingestToken: process.env.INGEST_TOKEN || '',
  },
};

export default config;
