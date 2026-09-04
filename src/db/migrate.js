/**
 * Aplica los archivos .sql de sql/ en orden alfabético, una sola vez cada uno.
 * Uso: npm run migrate
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction } from './pool.js';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sql');

export async function runMigrations({ log = console } = {}) {
  // La tabla de control vive dentro de 001_schema.sql, pero la necesitamos
  // antes de poder consultarla.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      log.info?.(`[migrate] ya aplicada: ${file}`);
      continue;
    }
    const sql = await readFile(join(SQL_DIR, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    });
    log.info?.(`[migrate] aplicada: ${file}`);
    count += 1;
  }
  return { applied: count, total: files.length };
}

// Ejecutado directamente desde la CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const r = await runMigrations({ log: { info: (m) => console.log(m) } });
    console.log(`[migrate] listo: ${r.applied} migración(es) nueva(s) de ${r.total}.`);
    await pool.end();
  } catch (err) {
    console.error('[migrate] falló:', err.message);
    await pool.end();
    process.exit(1);
  }
}
