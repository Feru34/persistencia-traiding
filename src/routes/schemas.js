/**
 * Esquemas compartidos: alimentan a la vez la validación de entrada, la
 * serialización de salida y la especificación OpenAPI de /docs.
 *
 * Nota sobre `additionalProperties: true` en las respuestas: Fastify serializa
 * con fast-json-stringify, que por defecto DESCARTA cualquier campo que no
 * esté declarado. Dejarlo en `true` garantiza que añadir un campo a un
 * `serialize()` nunca lo haga desaparecer en silencio de la respuesta.
 */

const nullableString = { type: ['string', 'null'] };
const nullableInt = { type: ['integer', 'null'] };
const nullableNum = { type: ['number', 'null'] };

export const SIDE_ENUM = ['BUY', 'SELL'];
export const STATUS_ENUM = [
  'PENDING', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCELLED',
];

export const schemas = [
  {
    $id: 'Error',
    type: 'object',
    additionalProperties: true,
    properties: {
      error: { type: 'string', description: 'Tipo de error', examples: ['ValidationError'] },
      message: { type: 'string', description: 'Descripción legible' },
      details: { description: 'Detalle por campo, cuando aplica' },
    },
  },

  {
    $id: 'Order',
    type: 'object',
    additionalProperties: true,
    description: 'Una oferta de compra o de venta registrada.',
    properties: {
      id: { type: 'string', format: 'uuid', description: 'UUIDv7 asignado por este backend' },
      clientOrderId: { ...nullableString, description: 'Id de idempotencia del cliente' },
      engineOrderId: { ...nullableInt, description: 'Id que asignó el motor de matching' },
      engineSessionId: { type: 'string', format: 'uuid', description: 'Ejecución del motor a la que pertenece' },
      userId: { type: 'integer' },
      assetId: { type: 'integer', minimum: 0, maximum: 4 },
      symbol: { type: 'string', description: 'Símbolo del activo (al consultar)' },
      side: { type: 'string', enum: SIDE_ENUM },
      price: { type: 'number', description: 'Precio en unidades decimales' },
      priceCents: { type: 'integer', description: 'Precio en centavos, tal como se almacena' },
      quantity: { type: 'integer' },
      filledQuantity: { type: 'integer', description: 'Cantidad ya emparejada' },
      remainingQuantity: { type: 'integer' },
      status: { type: 'string', enum: STATUS_ENUM },
      rejectReason: nullableString,
      createdAt: { type: 'string', format: 'date-time' },
      acceptedAt: { type: ['string', 'null'], format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  {
    $id: 'Trade',
    type: 'object',
    additionalProperties: true,
    description: 'Un emparejamiento materializado por el motor.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      assetId: { ...nullableInt, description: 'Resuelto cruzando contra las órdenes: el motor no lo envía' },
      symbol: nullableString,
      buyOrderId: { type: ['string', 'null'], format: 'uuid' },
      sellOrderId: { type: ['string', 'null'], format: 'uuid' },
      buyEngineOrderId: { type: 'integer' },
      sellEngineOrderId: { type: 'integer' },
      buyerUserId: nullableInt,
      sellerUserId: nullableInt,
      price: { type: 'number' },
      quantity: { type: 'integer' },
      grossAmount: { type: 'number', description: 'precio × cantidad' },
      buyerFee: { type: 'number', description: 'Comisión del intermediario al comprador' },
      sellerFee: { type: 'number' },
      executedAt: { type: 'string', format: 'date-time' },
      ingestedAt: { type: 'string', format: 'date-time' },
    },
  },

  {
    $id: 'TradeIngest',
    type: 'object',
    additionalProperties: false,
    description:
      'Emparejamiento tal como lo emite el motor por WebSocket. Solo trae los dos ids de '
      + 'orden: el activo, los usuarios y las comisiones los reconstruye este backend.',
    required: ['buyOrderId', 'sellOrderId', 'precio', 'cantidad'],
    properties: {
      buyOrderId: { type: 'integer', minimum: 0, description: 'Id de la orden de COMPRA en el motor' },
      sellOrderId: { type: 'integer', minimum: 0, description: 'Id de la orden de VENTA en el motor' },
      precio: { type: 'number', exclusiveMinimum: 0 },
      cantidad: { type: 'integer', minimum: 1 },
      executedAt: { type: 'string', format: 'date-time', description: 'Opcional; por defecto, la hora de ingesta' },
      engineSessionId: { type: 'string', format: 'uuid', description: 'Opcional; por defecto, la sesión activa' },
    },
  },

  {
    $id: 'Position',
    type: 'object',
    additionalProperties: true,
    description: 'Tenencia de un usuario sobre un activo.',
    properties: {
      assetId: { type: 'integer' },
      symbol: { type: 'string' },
      name: { type: 'string' },
      quantity: { type: 'integer', description: 'Negativa si vendió en corto: el motor no valida tenencias' },
      avgCost: { type: 'number', description: 'Costo promedio ponderado' },
      lastPrice: nullableNum,
      marketValue: { type: 'number' },
      unrealizedPnl: { type: 'number' },
      realizedPnl: { type: 'number' },
      feesPaid: { type: 'number' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  {
    $id: 'User',
    type: 'object',
    additionalProperties: true,
    properties: {
      id: { type: 'integer' },
      username: nullableString,
      cashBalance: { type: 'number' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  {
    $id: 'Asset',
    type: 'object',
    additionalProperties: true,
    properties: {
      id: { type: 'integer', minimum: 0, maximum: 4 },
      symbol: { type: 'string' },
      name: { type: 'string' },
      created_at: { type: 'string', format: 'date-time' },
    },
  },

  {
    $id: 'MarketState',
    type: 'object',
    additionalProperties: true,
    description: 'Estado de mercado de un activo, reconstruido desde la base.',
    properties: {
      assetId: { type: 'integer' },
      symbol: { type: 'string' },
      name: { type: 'string' },
      bestBid: { ...nullableNum, description: 'Mejor precio de compra vivo' },
      bestAsk: { ...nullableNum, description: 'Mejor precio de venta vivo' },
      spread: nullableNum,
      lastPrice: nullableNum,
      lastTradeAt: { type: ['string', 'null'], format: 'date-time' },
      openBuyOrders: { type: 'integer' },
      openSellOrders: { type: 'integer' },
      openBuyQuantity: { type: 'integer' },
      openSellQuantity: { type: 'integer' },
    },
  },

  {
    $id: 'BookLevel',
    type: 'object',
    additionalProperties: true,
    properties: {
      price: { type: 'number' },
      priceCents: { type: 'integer' },
      quantity: { type: 'integer', description: 'Cantidad viva agregada en ese nivel' },
      orders: { type: 'integer', description: 'Cuántas órdenes componen el nivel' },
    },
  },

  {
    $id: 'AssetSummary',
    type: 'object',
    additionalProperties: true,
    description: 'Resumen OHLC, volumen y comisiones de un activo.',
    properties: {
      assetId: { type: 'integer' },
      symbol: { type: 'string' },
      trades: { type: 'integer' },
      volume: { type: 'integer' },
      notional: { type: 'number', description: 'Monto total negociado' },
      fees: { type: 'number', description: 'Comisiones cobradas por el intermediario' },
      open: nullableNum,
      high: nullableNum,
      low: nullableNum,
      close: nullableNum,
    },
  },
];

/** Envoltorio `{ data: [...] }` que usan todos los listados. */
export const listOf = (ref) => ({
  type: 'object',
  additionalProperties: true,
  properties: { data: { type: 'array', items: { $ref: `${ref}#` } } },
});

/** Respuestas de error reutilizables. */
export const errorResponses = (...codes) =>
  Object.fromEntries(codes.map((c) => [c, { $ref: 'Error#', description: ERROR_DESCRIPTIONS[c] ?? 'Error' }]));

const ERROR_DESCRIPTIONS = {
  400: 'Petición inválida, o el motor rechazó la orden',
  401: 'Falta el token de ingesta o no es válido',
  404: 'No encontrado',
  409: 'La orden ya no se puede cancelar',
  502: 'El motor de matching no está disponible',
  503: 'Backpressure: la cola de persistencia está saturada',
};

/** Cuerpo común de una orden. `side` se añade solo en la ruta genérica. */
export const orderBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'assetId', 'price', 'quantity'],
  properties: {
    userId: { type: 'integer', minimum: 0, description: 'Id del trader', examples: [1] },
    assetId: {
      type: 'integer', minimum: 0, maximum: 4, examples: [2],
      description: 'Activo. El motor solo admite de 0 a 4.',
    },
    price: {
      type: 'number', exclusiveMinimum: 0, examples: [50.25],
      description: 'Precio en unidades decimales, máximo 2 decimales.',
    },
    quantity: { type: 'integer', minimum: 1, examples: [10] },
    clientOrderId: {
      type: 'string', maxLength: 128,
      description: 'Opcional. Reenviar la misma orden con este id devuelve la original en vez de duplicarla.',
    },
  },
};
