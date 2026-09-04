import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../config/index.js';
import { withTransaction } from '../db/pool.js';
import ordersRepo from '../repositories/orders.repo.js';
import tradesRepo from '../repositories/trades.repo.js';
import positionsRepo from '../repositories/positions.repo.js';
import { usersRepo } from '../repositories/reference.repo.js';
import { feeCents } from '../domain/money.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ITEM = Object.freeze({
  ORDER: 'order',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  TRADE: 'trade',
});

/**
 * Aplica un lote completo dentro de UNA transacción.
 *
 * El orden importa: usuarios -> órdenes -> confirmaciones -> trades -> fills
 * -> posiciones -> efectivo. Como la cola es FIFO y una orden siempre se
 * encola antes que sus trades, al llegar aquí la orden referenciada ya está
 * en este mismo lote o en uno anterior ya confirmado.
 */
export async function applyBatch(client, items) {
  const orders = [];
  const accepted = [];
  const rejected = [];
  const trades = [];

  for (const item of items) {
    if (item.type === ITEM.ORDER) orders.push(item.payload);
    else if (item.type === ITEM.ACCEPTED) accepted.push(item.payload);
    else if (item.type === ITEM.REJECTED) rejected.push(item.payload);
    else if (item.type === ITEM.TRADE) trades.push(item.payload);
  }

  const stats = { orders: 0, accepted: 0, rejected: 0, trades: 0, duplicates: 0, fills: 0, positions: 0 };

  // 1. Usuarios (FK de orders). Alta idempotente.
  if (config.business.autoCreateUsers && orders.length > 0) {
    const users = [...new Set(orders.map((o) => o.userId))].map((id) => ({ id }));
    await usersRepo.ensureMany(client, users);
  }

  // 2. Órdenes
  if (orders.length > 0) stats.orders = await ordersRepo.insertMany(client, orders);
  if (accepted.length > 0) stats.accepted = await ordersRepo.markAccepted(client, accepted);
  if (rejected.length > 0) stats.rejected = await ordersRepo.markRejected(client, rejected);

  // 3. Trades
  if (trades.length > 0) {
    // El TradeEvent del motor solo trae ids de orden. Resolvemos activo,
    // usuarios y nuestros UUID con UNA consulta indexada por lote (no por trade).
    // Se lee de la BD —y no de una caché— para garantizar que las FK existen.
    const bySession = new Map();
    for (const t of trades) {
      if (!bySession.has(t.engineSessionId)) bySession.set(t.engineSessionId, new Set());
      bySession.get(t.engineSessionId).add(t.buyEngineOrderId);
      bySession.get(t.engineSessionId).add(t.sellEngineOrderId);
    }

    const index = new Map(); // `${sessionId}:${engineOrderId}` -> fila de orders
    for (const [sessionId, ids] of bySession) {
      const rows = await ordersRepo.findByEngineIds(client, sessionId, [...ids]);
      for (const r of rows) index.set(`${sessionId}:${r.engine_order_id}`, r);
    }

    const enriched = trades.map((t) => {
      const buy = index.get(`${t.engineSessionId}:${t.buyEngineOrderId}`);
      const sell = index.get(`${t.engineSessionId}:${t.sellEngineOrderId}`);
      const gross = t.priceCents * t.quantity;
      const fee = feeCents(gross, config.business.feeBps);
      return {
        ...t,
        buyOrderId: buy?.id ?? null,
        sellOrderId: sell?.id ?? null,
        // Si una pata no resuelve (p. ej. orden inyectada por otro proceso),
        // el trade se guarda igual: nunca se pierde el hecho económico.
        assetId: buy?.asset_id ?? sell?.asset_id ?? null,
        buyerUserId: buy?.user_id ?? null,
        sellerUserId: sell?.user_id ?? null,
        buyerFeeCents: fee,
        sellerFeeCents: fee,
        _buy: buy,
        _sell: sell,
      };
    });

    const insertedIds = await tradesRepo.insertMany(
      client,
      enriched.map(({ _buy, _sell, ...t }) => t),
    );
    stats.trades = insertedIds.length;
    stats.duplicates = enriched.length - insertedIds.length;

    // Solo los trades REALMENTE insertados mueven órdenes, posiciones y saldos.
    // Así un reenvío del mismo trade no vuelve a descontar acciones ni dinero.
    const insertedSet = new Set(insertedIds);
    const applied = enriched.filter((t) => insertedSet.has(t.id));

    if (applied.length > 0) {
      const fills = [];
      const legs = [];
      const cash = new Map();
      const addCash = (userId, delta) => {
        if (userId == null) return;
        cash.set(userId, (cash.get(userId) ?? 0) + delta);
      };

      for (const t of applied) {
        if (t.buyOrderId) fills.push({ orderId: t.buyOrderId, quantity: t.quantity });
        if (t.sellOrderId) fills.push({ orderId: t.sellOrderId, quantity: t.quantity });

        if (t.assetId != null) {
          if (t.buyerUserId != null) {
            legs.push({ userId: t.buyerUserId, assetId: t.assetId, quantity: t.quantity, priceCents: t.priceCents, feeCents: t.buyerFeeCents });
          }
          if (t.sellerUserId != null) {
            legs.push({ userId: t.sellerUserId, assetId: t.assetId, quantity: -t.quantity, priceCents: t.priceCents, feeCents: t.sellerFeeCents });
          }
        }

        const gross = t.priceCents * t.quantity;
        addCash(t.buyerUserId, -(gross + t.buyerFeeCents));  // el comprador paga
        addCash(t.sellerUserId, gross - t.sellerFeeCents);   // el vendedor cobra
      }

      if (fills.length > 0) stats.fills = await ordersRepo.applyFills(client, fills);
      if (legs.length > 0) stats.positions = await positionsRepo.applyLegs(client, legs);
      await usersRepo.applyCashDeltas(client, cash);
    }
  }

  return stats;
}

/**
 * Escritor write-behind.
 *
 * Saca la escritura a RDS del camino crítico del request: la orden se inyecta
 * al motor y se responde de inmediato, mientras la persistencia se agrupa en
 * lotes (equivale al "JDBC upsert (batch)" del diagrama de despliegue).
 */
export class BatchWriter {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.queue = [];
    this.timer = null;
    this.flushing = false;
    this.closed = false;
    this.metrics = {
      enqueued: 0, dropped: 0, flushed: 0, duplicates: 0,
      batches: 0, failures: 0, deadLettered: 0,
      queueDepth: 0, maxQueueDepth: 0, lastFlushMs: 0, lastFlushAt: null,
    };
  }

  start() {
    if (this.timer || config.persist.mode !== 'async') return;
    this.timer = setInterval(() => {
      this.flush().catch((err) => this.logger.error?.({ err }, '[batch] fallo en flush periódico'));
    }, config.persist.intervalMs);
    this.timer.unref?.();
  }

  get depth() { return this.queue.length; }

  get saturated() {
    return this.queue.length >= (config.persist.maxQueue * config.persist.highWatermarkPct) / 100;
  }

  /**
   * Encola trabajo. Devuelve false si la cola está saturada, para que la ruta
   * responda 503 en vez de crecer sin límite hasta agotar la memoria.
   */
  enqueue(items) {
    if (this.closed) return false;
    if (this.queue.length + items.length > config.persist.maxQueue) {
      this.metrics.dropped += items.length;
      return false;
    }
    this.queue.push(...items);
    this.metrics.enqueued += items.length;
    this.metrics.queueDepth = this.queue.length;
    this.metrics.maxQueueDepth = Math.max(this.metrics.maxQueueDepth, this.queue.length);
    if (this.queue.length >= config.persist.batchSize) {
      // No esperamos al timer si ya hay lote completo.
      this.flush().catch((err) => this.logger.error?.({ err }, '[batch] fallo en flush por tamaño'));
    }
    return true;
  }

  async flush() {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, config.persist.batchSize);
        this.metrics.queueDepth = this.queue.length;
        await this.#writeWithRetry(batch);
        if (this.closed === false && this.queue.length < config.persist.batchSize) break;
      }
    } finally {
      this.flushing = false;
    }
  }

  async #writeWithRetry(batch) {
    const started = Date.now();
    for (let attempt = 0; attempt <= config.persist.retryAttempts; attempt += 1) {
      try {
        const stats = await withTransaction((client) => applyBatch(client, batch));
        this.metrics.batches += 1;
        this.metrics.flushed += batch.length;
        this.metrics.duplicates += stats.duplicates;
        this.metrics.lastFlushMs = Date.now() - started;
        this.metrics.lastFlushAt = new Date().toISOString();
        return;
      } catch (err) {
        this.metrics.failures += 1;
        if (attempt === config.persist.retryAttempts) {
          this.logger.error?.(
            { err: err.message, items: batch.length },
            '[batch] lote descartado tras agotar reintentos; va a dead letter',
          );
          await this.#deadLetter(batch, err);
          return;
        }
        await sleep(config.persist.retryDelayMs * 2 ** attempt);
      }
    }
  }

  /** Un lote irrecuperable se vuelca a disco en NDJSON para poder reprocesarlo. */
  async #deadLetter(batch, err) {
    try {
      await mkdir(dirname(config.persist.deadLetterPath), { recursive: true });
      const line = `${JSON.stringify({ at: new Date().toISOString(), error: err.message, batch })}\n`;
      await appendFile(config.persist.deadLetterPath, line);
      this.metrics.deadLettered += batch.length;
    } catch (writeErr) {
      this.logger.error?.({ err: writeErr.message }, '[batch] no se pudo escribir el dead letter');
    }
  }

  /** Vacía la cola antes de terminar el proceso (SIGTERM). */
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

export const batchWriter = new BatchWriter();

/**
 * Fachada de persistencia. Es el único punto que conoce la diferencia entre
 * los modos `async` (write-behind) y `sync` (write-through), de modo que las
 * rutas y servicios son idénticos en ambos.
 */
export const persistence = {
  writer: batchWriter,

  isAsync: () => config.persist.mode === 'async',

  /** @returns {Promise<boolean>} false si hay backpressure (cola llena) */
  async submit(items) {
    if (items.length === 0) return true;
    if (config.persist.mode === 'async') return batchWriter.enqueue(items);
    await withTransaction((client) => applyBatch(client, items));
    return true;
  },

  metrics: () => ({
    mode: config.persist.mode,
    ...batchWriter.metrics,
    queueDepth: batchWriter.depth,
    saturated: batchWriter.saturated,
  }),
};

export default persistence;
