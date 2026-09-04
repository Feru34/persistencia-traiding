/**
 * Reprocesa los lotes que el escritor no pudo persistir.
 *
 * Cada línea de logs/dead-letter.ndjson es un lote completo con el mismo
 * formato que consume applyBatch, así que se reintenta tal cual. Las
 * operaciones son idempotentes (ON CONFLICT DO NOTHING + trades con clave
 * única), de modo que reprocesar un lote ya aplicado no duplica nada.
 *
 * Uso: node scripts/replay-dead-letter.js [ruta]
 */
import 'dotenv/config';
import { readFile, rename } from 'node:fs/promises';
import { config } from '../src/config/index.js';
import { pool, withTransaction } from '../src/db/pool.js';
import { applyBatch } from '../src/services/persistence.js';

const path = process.argv[2] || config.persist.deadLetterPath;

let raw;
try {
  raw = await readFile(path, 'utf8');
} catch (err) {
  console.error(`No se pudo leer ${path}: ${err.message}`);
  process.exit(1);
}

const lines = raw.split('\n').filter((l) => l.trim());
console.log(`${lines.length} lote(s) en ${path}`);

let recovered = 0;
const stillFailing = [];

for (const [i, line] of lines.entries()) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    console.error(`  lote ${i + 1}: línea ilegible, se conserva`);
    stillFailing.push(line);
    continue;
  }
  try {
    const stats = await withTransaction((client) => applyBatch(client, entry.batch));
    recovered += entry.batch.length;
    console.log(`  lote ${i + 1}: OK ${JSON.stringify(stats)}`);
  } catch (err) {
    console.error(`  lote ${i + 1}: sigue fallando -> ${err.message}`);
    stillFailing.push(line);
  }
}

// Solo se archiva el original si TODO se recuperó; si no, se conserva lo pendiente.
if (stillFailing.length === 0) {
  const archived = `${path}.${Date.now()}.done`;
  await rename(path, archived);
  console.log(`\n${recovered} elemento(s) recuperados. Archivo movido a ${archived}`);
} else {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, `${stillFailing.join('\n')}\n`);
  console.log(`\n${recovered} recuperados, ${stillFailing.length} lote(s) siguen fallando (se conservan en ${path})`);
}

await pool.end();
