import { buildApp } from './app.js';
import { config } from './config/index.js';
import { closePool, pool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import persistence from './services/persistence.js';
import sessionManager from './services/sessionManager.js';

const app = await buildApp();

try {
  await pool.query('SELECT 1');
  app.log.info(
    { host: config.db.connectionString ? '(DATABASE_URL)' : `${config.db.host}:${config.db.port}` },
    'conectado a PostgreSQL',
  );
  // Dentro de docker compose el host `postgres` es el PostgreSQL local del
  // compose. Las variables PG* sueltas del .env NO llegan al contenedor; la
  // RDS solo se alcanza con DATABASE_URL. Sin este aviso se puede medir
  // contra la base equivocada sin notarlo.
  if (!config.db.connectionString && config.db.host === 'postgres') {
    app.log.warn(
      'usando el PostgreSQL LOCAL del compose, no una RDS. Para apuntar a RDS define DATABASE_URL en el .env',
    );
  }

  // Idempotente: aplica solo lo que falte. Cómodo en ECS/Fargate, donde el
  // contenedor arranca sin un paso de migración aparte.
  await runMigrations({ log: app.log });

  await sessionManager.init(app.log);
  persistence.writer.start();

  await app.listen({ port: config.server.port, host: config.server.host });
  app.log.info(
    { mode: config.persist.mode, engine: config.engine.baseUrl },
    `persistencia en modo ${config.persist.mode}`,
  );
} catch (err) {
  app.log.error({ err }, 'no se pudo arrancar el servidor');
  await closePool().catch(() => {});
  process.exit(1);
}

/**
 * Apagado ordenado: dejar de recibir tráfico, vaciar la cola de escritura y
 * cerrar el pool. Sin esto, en modo async un despliegue perdería los lotes
 * que aún estuvieran en memoria.
 */
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} recibido: apagando...`);
    try {
      sessionManager.stop();
      await app.close();
      await persistence.writer.close();
      app.log.info({ metrics: persistence.metrics() }, 'cola de persistencia vaciada');
      await closePool();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error durante el apagado');
      process.exit(1);
    }
  });
}
