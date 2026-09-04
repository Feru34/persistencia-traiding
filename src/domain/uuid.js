import { randomBytes } from 'node:crypto';

/**
 * UUIDv7: 48 bits de timestamp en milisegundos + aleatoriedad.
 *
 * Se genera en la app (no en la BD) porque en modo async hay que responder al
 * cliente antes de que el INSERT ocurra. Al ser monótono en el tiempo mantiene
 * la localidad del índice B-tree, evitando la fragmentación que provoca un
 * UUIDv4 aleatorio en tablas de alta escritura.
 */
export function uuidv7() {
  const bytes = randomBytes(16);
  const ts = BigInt(Date.now());

  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  bytes[6] = (bytes[6] & 0x0f) | 0x70; // versión 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
