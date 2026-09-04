/**
 * Todo el dinero se almacena en centavos (BIGINT) para evitar la deriva del
 * punto flotante. El motor hace lo mismo: `precioCentavos = (long)(precio * 100)`.
 */

/** Convierte un precio decimal (p. ej. 100.50) a centavos enteros. */
export function toCents(price) {
  // Redondear (no truncar) evita que 1.15 * 100 = 114.99999999999999 -> 114.
  return Math.round(Number(price) * 100);
}

/** Convierte centavos a un número decimal con 2 posiciones. */
export function toUnits(cents) {
  return Number((Number(cents) / 100).toFixed(2));
}

/** ¿El precio tiene como máximo 2 decimales? */
export function hasValidPrecision(price) {
  const s = String(price);
  if (!s.includes('.')) return true;
  return s.split('.')[1].length <= 2;
}

/**
 * Comisión del intermediario en puntos básicos.
 * 25 bps = 0.25%. Se redondea hacia abajo al centavo.
 */
export function feeCents(amountCents, bps) {
  return Math.floor((Number(amountCents) * Number(bps)) / 10_000);
}
