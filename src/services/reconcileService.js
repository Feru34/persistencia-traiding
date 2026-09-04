import { withTransaction } from '../db/pool.js';
import ordersRepo from '../repositories/orders.repo.js';
import engineClient from './engineClient.js';
import sessionManager from './sessionManager.js';

/**
 * Reconciliación contra el libro vivo del motor.
 *
 * Por qué hace falta: el motor publica los emparejamientos por WebSocket sin
 * ningún búfer de reenvío. Si el worker de persistencia está caído cuando
 * ocurre un trade, ese evento se pierde para siempre — el motor no lo repite.
 * (Es justamente el hueco que tapa Amazon MSK en el diagrama de despliegue:
 * el bróker retiene los eventos hasta que alguien los consume.)
 *
 * `GET /api/libro` sí expone el estado actual de cada orden viva, así que
 * comparando `cantidadRestante` con lo que tenemos guardado se detecta —y se
 * corrige— la deriva.
 *
 * Límite importante y deliberado: se repara el estado de las ÓRDENES, nunca
 * se inventan trades. El motor no dice contra quién se emparejó cada orden,
 * así que los trades perdidos no se pueden reconstruir y las posiciones y
 * saldos que dependían de ellos quedan incompletos. El informe cuantifica
 * cuánto volumen quedó sin respaldo para que la brecha sea visible.
 */
export const reconcileService = {
  async run({ repair = false } = {}) {
    const sessionId = sessionManager.current;
    const [book, ours] = await Promise.all([
      engineClient.getBook(),
      ordersRepo.listOpenBySession(sessionId),
    ]);

    const byEngineId = new Map(ours.map((o) => [Number(o.engine_order_id), o]));
    const seen = new Set();

    const drift = [];          // la cantidad ejecutada no coincide
    const missingInEngine = []; // nosotros la creemos viva, el motor ya no la tiene
    const unknownToBackend = []; // el motor la tiene, nosotros no la registramos

    for (const snap of book) {
      const engineOrderId = Number(snap.id);
      seen.add(engineOrderId);
      const our = byEngineId.get(engineOrderId);
      if (!our) {
        unknownToBackend.push({
          engineOrderId,
          userId: Number(snap.idUsuario),
          assetId: Number(snap.idActivo),
          side: Number(snap.tipo) === 0 ? 'BUY' : 'SELL',
          price: snap.precio,
          remaining: Number(snap.cantidadRestante),
        });
        continue;
      }
      const engineFilled = Number(snap.cantidadOriginal) - Number(snap.cantidadRestante);
      if (engineFilled !== Number(our.filled_quantity)) {
        drift.push({
          orderId: our.id,
          engineOrderId,
          assetId: Number(our.asset_id),
          side: our.side,
          ourFilled: Number(our.filled_quantity),
          engineFilled,
          missingQuantity: engineFilled - Number(our.filled_quantity),
        });
      }
    }

    for (const our of ours) {
      const engineOrderId = Number(our.engine_order_id);
      if (seen.has(engineOrderId)) continue;
      // Ya no está en el libro: o se ejecutó por completo, o el motor perdió
      // su memoria. Se reporta siempre; solo se cierra si piden reparar.
      missingInEngine.push({
        orderId: our.id,
        engineOrderId,
        assetId: Number(our.asset_id),
        side: our.side,
        ourFilled: Number(our.filled_quantity),
        assumedFilled: Number(our.quantity),
        missingQuantity: Number(our.quantity) - Number(our.filled_quantity),
      });
    }

    let repaired = 0;
    if (repair && (drift.length > 0 || missingInEngine.length > 0)) {
      const updates = [
        ...drift.map((d) => ({ orderId: d.orderId, quantity: d.engineFilled })),
        ...missingInEngine.map((m) => ({ orderId: m.orderId, quantity: m.assumedFilled })),
      ];
      repaired = await withTransaction((client) => ordersRepo.setFills(client, updates));
    }

    const unaccountedQuantity =
      drift.reduce((s, d) => s + Math.max(0, d.missingQuantity), 0) +
      missingInEngine.reduce((s, m) => s + Math.max(0, m.missingQuantity), 0);

    return {
      sessionId,
      checkedOrders: ours.length,
      engineBookSize: book.length,
      drift,
      missingInEngine,
      unknownToBackend,
      repaired,
      unaccountedQuantity,
      note: unaccountedQuantity > 0
        ? `${unaccountedQuantity} unidad(es) de orden (sumando ambos lados: un trade de N unidades cuenta 2N) `
          + 'se ejecutaron sin que llegara su trade. '
          + 'La reparación corrige el estado de las órdenes, pero esos trades no se pueden '
          + 'reconstruir (el motor no informa la contraparte), así que posiciones y saldos '
          + 'quedan incompletos para ese volumen.'
        : 'Sin discrepancias.',
    };
  },
};

export default reconcileService;
