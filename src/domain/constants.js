/**
 * Contrato del motor de matching (MatchineEngine.jar), verificado
 * ejecutándolo y observando su API real.
 *
 *   POST /api/ordenes       body {idUsuario, idActivo, tipo, precio, cantidad}
 *                           -> 202 "Orden inyectada correctamente con ID: N"
 *                           -> 400 "idActivo inválido. Debe estar entre 0 y 4."
 *                           -> 503 "Pool de memoria agotado." | "buffer ... lleno"
 *   POST /api/emparejar     dispara un lote de emparejamiento
 *   POST /api/reset         reinicia el motor (y su contador de IDs)
 *   GET  /api/estadisticas  -> EstadisticasResponse
 *   GET  /api/libro         -> [OrdenSnapshot]
 *   WS   /api/trades/stream -> {buyOrderId, sellOrderId, precio, cantidad}
 */

/** Valor de `tipo` en el motor. Confirmado ejecutando el JAR. */
export const ENGINE_SIDE = Object.freeze({ BUY: 0, SELL: 1 });

export const SIDE = Object.freeze({ BUY: 'BUY', SELL: 'SELL' });

export const ORDER_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
});

/** Estados en los que una orden sigue viva en el libro. */
export const OPEN_STATUSES = Object.freeze([
  ORDER_STATUS.ACCEPTED,
  ORDER_STATUS.PARTIALLY_FILLED,
]);

export const sideToEngine = (side) => (side === SIDE.BUY ? ENGINE_SIDE.BUY : ENGINE_SIDE.SELL);
export const engineToSide = (tipo) => (Number(tipo) === ENGINE_SIDE.BUY ? SIDE.BUY : SIDE.SELL);
