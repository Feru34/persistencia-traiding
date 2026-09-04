import { config } from '../config/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Error de comunicación/negocio con el motor de matching. */
export class EngineError extends Error {
  constructor(message, { status = 502, retryable = false, body = null } = {}) {
    super(message);
    this.name = 'EngineError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

/** El motor responde 202 con el id embebido en texto plano. */
const ID_RE = /ID:\s*(\d+)/i;

async function request(path, { method = 'GET', body, timeoutMs } = {}) {
  const url = `${config.engine.baseUrl}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs ?? config.engine.timeoutMs),
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new EngineError(
      timedOut
        ? `El motor no respondió en ${timeoutMs ?? config.engine.timeoutMs}ms (${url})`
        : `No se pudo contactar al motor en ${url}: ${err.message}`,
      { status: 504, retryable: true },
    );
  }

  const text = await res.text();
  if (!res.ok) {
    // 503 = pool de memoria agotado o ring buffer lleno -> reintentable.
    // 4xx = la orden es inválida para el motor -> NO reintentable.
    throw new EngineError(text || `El motor respondió ${res.status}`, {
      status: res.status,
      retryable: res.status >= 500,
      body: text,
    });
  }
  return text;
}

async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= config.engine.retryAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof EngineError) || !err.retryable) throw err;
      if (attempt < config.engine.retryAttempts) {
        // Backoff exponencial: el 503 del motor suele durar microsegundos
        // (el ring buffer se drena), así que esperas cortas bastan.
        await sleep(config.engine.retryDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastErr;
}

export const engineClient = {
  /**
   * Inyecta una orden en el motor.
   * @returns {Promise<number>} el id de orden que asignó el motor
   */
  async placeOrder({ idUsuario, idActivo, tipo, precio, cantidad }) {
    const text = await withRetry(() =>
      request('/api/ordenes', {
        method: 'POST',
        body: { idUsuario, idActivo, tipo, precio, cantidad },
      }),
    );
    const match = ID_RE.exec(text);
    if (!match) {
      throw new EngineError(`Respuesta inesperada del motor: "${text}"`, { status: 502 });
    }
    return Number(match[1]);
  },

  /** Fuerza un ciclo de emparejamiento (útil con matching.strategy=PERIODICO). */
  triggerMatching() {
    return request('/api/emparejar', { method: 'POST' });
  },

  /** Reinicia el motor. OJO: reinicia también su contador de IDs de orden. */
  reset() {
    return request('/api/reset', { method: 'POST' });
  },

  async getStats() {
    return JSON.parse(await request('/api/estadisticas'));
  },

  /** Libro de órdenes vivo, tal como lo ve el motor (fuente de verdad). */
  async getBook() {
    return JSON.parse(await request('/api/libro'));
  },

  async getHash() {
    return JSON.parse(await request('/api/admin/hash'));
  },
};

export default engineClient;
