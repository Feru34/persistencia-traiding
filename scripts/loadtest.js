/**
 * Generador de carga para validar los requisitos de calidad del reto:
 *   - registro de oferta de venta  < 500 ms
 *   - registro de oferta de compra < 300 ms
 *   - carga normal: 500 ventas/min y 800 compras/min
 *
 * Uso:
 *   node scripts/loadtest.js --orders 2000 --concurrency 50
 *   node scripts/loadtest.js --rate 1300 --duration 60   (órdenes/min durante N s)
 */
import 'dotenv/config';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const BASE = args.get('url') || `http://localhost:${process.env.PORT || 3000}`;
const TOTAL = Number(args.get('orders') || 1000);
const CONCURRENCY = Number(args.get('concurrency') || 50);
const RATE_PER_MIN = args.has('rate') ? Number(args.get('rate')) : null;
const DURATION_S = Number(args.get('duration') || 60);
const ASSETS = Number(process.env.ASSET_COUNT || 5);

const latencies = { BUY: [], SELL: [] };
const errors = new Map();
let ok = 0;
let failed = 0;

const randomOrder = () => {
  const side = Math.random() < 800 / 1300 ? 'BUY' : 'SELL'; // mezcla 800/500 del enunciado
  return {
    side,
    body: {
      userId: 1 + Math.floor(Math.random() * 4),
      assetId: Math.floor(Math.random() * ASSETS),
      price: Number((50 + Math.random() * 20).toFixed(2)),
      quantity: 1 + Math.floor(Math.random() * 50),
    },
  };
};

async function sendOne() {
  const { side, body } = randomOrder();
  const path = side === 'BUY' ? '/api/v1/orders/buy' : '/api/v1/orders/sell';
  const started = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const elapsed = performance.now() - started;
    if (res.ok) {
      latencies[side].push(elapsed);
      ok += 1;
    } else {
      failed += 1;
      const key = `HTTP ${res.status}`;
      errors.set(key, (errors.get(key) ?? 0) + 1);
      await res.text();
    }
  } catch (err) {
    failed += 1;
    errors.set(err.message, (errors.get(err.message) ?? 0) + 1);
  }
}

const pct = (arr, p) => {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

function report(elapsedS) {
  const fmt = (side, limit) => {
    const a = latencies[side];
    if (a.length === 0) return `  ${side.padEnd(5)}  sin muestras`;
    const p99 = pct(a, 99);
    const flag = p99 <= limit ? 'OK ' : 'FALLA';
    return `  ${side.padEnd(5)} n=${String(a.length).padStart(6)}  `
      + `avg=${(a.reduce((s, x) => s + x, 0) / a.length).toFixed(1)}ms  `
      + `p50=${pct(a, 50).toFixed(1)}ms  p95=${pct(a, 95).toFixed(1)}ms  `
      + `p99=${p99.toFixed(1)}ms  max=${Math.max(...a).toFixed(1)}ms  [${flag} < ${limit}ms]`;
  };

  console.log('\n=============== Resultados ===============');
  console.log(`  duración        : ${elapsedS.toFixed(1)} s`);
  console.log(`  órdenes ok      : ${ok}`);
  console.log(`  órdenes fallidas: ${failed}`);
  console.log(`  throughput      : ${(ok / elapsedS).toFixed(1)} órdenes/s  (${(60 * ok / elapsedS).toFixed(0)}/min)`);
  console.log('\n  Latencia de registro (requisito del enunciado):');
  console.log(fmt('SELL', 500));
  console.log(fmt('BUY', 300));
  if (errors.size > 0) {
    console.log('\n  Errores:');
    for (const [k, v] of errors) console.log(`    ${v} x ${k}`);
  }
  console.log('==========================================\n');
}

const started = performance.now();

if (RATE_PER_MIN) {
  // Carga a tasa constante: mide latencia en régimen estable.
  const intervalMs = 60_000 / RATE_PER_MIN;
  console.log(`Enviando ${RATE_PER_MIN} órdenes/min durante ${DURATION_S}s hacia ${BASE}...`);
  const inflight = new Set();
  const timer = setInterval(() => {
    const p = sendOne().finally(() => inflight.delete(p));
    inflight.add(p);
  }, intervalMs);
  setTimeout(async () => {
    clearInterval(timer);
    await Promise.allSettled([...inflight]);
    report((performance.now() - started) / 1000);
    process.exit(0);
  }, DURATION_S * 1000);
} else {
  // Carga por lotes: mide capacidad máxima.
  console.log(`Enviando ${TOTAL} órdenes con concurrencia ${CONCURRENCY} hacia ${BASE}...`);
  let issued = 0;
  const worker = async () => {
    while (issued < TOTAL) {
      issued += 1;
      await sendOne();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  report((performance.now() - started) / 1000);
}
