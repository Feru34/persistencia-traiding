/**
 * Construye la lista de placeholders para un INSERT/VALUES multi-fila:
 *   valuesClause(2, 3) -> "($1,$2,$3),($4,$5,$6)"
 *
 * Insertar N filas en una sola sentencia en vez de N sentencias es la
 * diferencia entre N round-trips a RDS y uno solo — la base del escritor
 * por lotes.
 *
 * `types` añade casts explícitos:
 *   valuesClause(1, 2, 1, ['uuid', 'integer']) -> "($1::uuid,$2::integer)"
 *
 * Es obligatorio en un `FROM (VALUES ...) AS t(...)`: ahí PostgreSQL no tiene
 * una columna destino de la que inferir el tipo y asume `text`, lo que rompe
 * cualquier aritmética posterior ("operator does not exist: integer + text").
 * En un INSERT normal no hace falta, porque el tipo sale de la columna destino.
 */
export function valuesClause(rowCount, columnCount, startAt = 1, types = null) {
  let i = startAt;
  const rows = [];
  for (let r = 0; r < rowCount; r += 1) {
    const cols = [];
    for (let c = 0; c < columnCount; c += 1) {
      cols.push(types?.[c] ? `$${i++}::${types[c]}` : `$${i++}`);
    }
    rows.push(`(${cols.join(',')})`);
  }
  return rows.join(',');
}

/** Aplana una matriz de filas en el arreglo de parámetros que espera pg. */
export const flatten = (rows) => rows.flat();
