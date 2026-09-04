/**
 * Puente WebSocket -> HTTP (el "Worker de Persistencia" del diagrama).
 *
 * El motor solo publica los emparejamientos por WebSocket; este backend los
 * recibe por POST /api/v1/trades. Este proceso une ambos extremos: escucha el
 * stream del motor, agrupa los trades y los empuja por lotes.
 *
 * Corre APARTE del backend (npm run bridge) para que la caída de uno no
 * arrastre al otro, igual que en el diagrama de despliegue.
 */
import 'dotenv/config';

const WS_URL = process.env.BRIDGE_ENGINE_WS_URL || 'ws://localhost:8080/api/trades/stream';
const TARGET = process.env.BRIDGE_TARGET_URL || 'http://localhost:3000/api/v1/trades';
const BATCH_SIZE = Number(process.env.BRIDGE_BATCH_SIZE || 200);
const FLUSH_MS = Number(process.env.BRIDGE_FLUSH_MS || 50);
const TOKEN = process.env.INGEST_TOKEN || '';

let buffer = [];
let sent = 0;
let failed = 0;
let received = 0;

async function flush() {
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    const res = await fetch(TARGET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Ingest-Token': TOKEN } : {}) },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      failed += batch.length;
      console.error(`[bridge] el backend respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
      // 503 = backpressure: devolvemos el lote a la cola para reintentarlo.
      if (res.status === 503) buffer = batch.concat(buffer);
      return;
    }
    sent += batch.length;
  } catch (err) {
    failed += batch.length;
    buffer = batch.concat(buffer);
    console.error(`[bridge] fallo al enviar: ${err.message}`);
  }
}

function connect() {
  console.log(`[bridge] conectando a ${WS_URL}`);
  const ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => console.log(`[bridge] conectado; empujando a ${TARGET}`));

  ws.addEventListener('message', (event) => {
    try {
      const trade = JSON.parse(event.data);
      buffer.push(trade);
      received += 1;
      if (buffer.length >= BATCH_SIZE) flush();
    } catch (err) {
      console.error(`[bridge] mensaje ilegible: ${err.message}`);
    }
  });

  ws.addEventListener('error', (event) => console.error(`[bridge] error de websocket: ${event.message ?? event.type}`));

  ws.addEventListener('close', () => {
    console.warn('[bridge] conexión cerrada; reintentando en 1s');
    setTimeout(connect, 1000);
  });
}

setInterval(flush, FLUSH_MS).unref();
setInterval(() => console.log(`[bridge] recibidos=${received} enviados=${sent} fallidos=${failed} pendientes=${buffer.length}`), 10_000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('[bridge] vaciando antes de salir...');
    await flush();
    process.exit(0);
  });
}

connect();
