-- ===========================================================================
-- Backend de Persistencia de Trading — ARTI4109 Reto 1
-- Esquema PostgreSQL (AWS RDS / Aurora PostgreSQL)
--
-- Convención de dinero: TODO se almacena en CENTAVOS (BIGINT).
-- El motor de matching hace lo mismo internamente (Orden.precioCentavos),
-- así evitamos errores de redondeo de punto flotante.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Tipos enumerados
-- --------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE order_side AS ENUM ('BUY', 'SELL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- PENDING           : persistida, aún no confirmada por el motor
  -- ACCEPTED          : el motor la aceptó y vive en el libro de órdenes
  -- PARTIALLY_FILLED  : emparejada parcialmente
  -- FILLED            : emparejada en su totalidad
  -- REJECTED          : el motor la rechazó (libro lleno, activo inválido...)
  -- CANCELLED         : cancelada
  CREATE TYPE order_status AS ENUM (
    'PENDING', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------------------------
-- Sesiones del motor
--
-- El motor reinicia su contador de IDs de orden en 1 cada vez que arranca o
-- recibe POST /api/reset. Sin este concepto, las órdenes de dos ejecuciones
-- distintas colisionarían y los trades se asociarían a la orden equivocada.
-- Cada arranque/reset abre una nueva sesión.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS engine_sessions (
  id          UUID PRIMARY KEY,
  reason      TEXT NOT NULL,
  engine_url  TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_engine_sessions_open
  ON engine_sessions (started_at DESC) WHERE ended_at IS NULL;

-- --------------------------------------------------------------------------
-- Activos (acciones). El motor solo admite idActivo en [0, 4].
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
  id          INTEGER PRIMARY KEY,
  symbol      TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Usuarios (traders). El id lo asigna el cliente: el motor recibe `idUsuario`
-- como un long arbitrario, así que aquí NO es autoincremental.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  BIGINT PRIMARY KEY,
  username            TEXT UNIQUE,
  cash_balance_cents  BIGINT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Órdenes (ofertas de compra y de venta)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  -- UUIDv7: generado por la app (no por la BD) para poder responder al cliente
  -- sin esperar el INSERT en modo async. Es time-ordered, así que conserva la
  -- localidad del índice como un BIGSERIAL.
  id                 UUID PRIMARY KEY,

  engine_session_id  UUID NOT NULL REFERENCES engine_sessions(id),
  -- ID que devuelve el motor ("Orden inyectada correctamente con ID: N")
  engine_order_id    BIGINT,
  -- ID de idempotencia provisto por el cliente
  client_order_id    TEXT,

  user_id            BIGINT  NOT NULL REFERENCES users(id),
  asset_id           INTEGER NOT NULL REFERENCES assets(id),
  side               order_side NOT NULL,

  price_cents        BIGINT  NOT NULL CHECK (price_cents > 0),
  quantity           INTEGER NOT NULL CHECK (quantity > 0),
  filled_quantity    INTEGER NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  remaining_quantity INTEGER GENERATED ALWAYS AS (quantity - filled_quantity) STORED,

  status             order_status NOT NULL DEFAULT 'PENDING',
  reject_reason      TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at        TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT orders_filled_lte_qty CHECK (filled_quantity <= quantity)
);

-- Un engine_order_id es único DENTRO de una sesión del motor.
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_engine
  ON orders (engine_session_id, engine_order_id)
  WHERE engine_order_id IS NOT NULL;

-- Idempotencia de reintentos del cliente.
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_client_order_id
  ON orders (client_order_id) WHERE client_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_user      ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_asset     ON orders (asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders (status, created_at DESC);
-- Índice que soporta la reconstrucción del libro de órdenes.
CREATE INDEX IF NOT EXISTS idx_orders_book
  ON orders (asset_id, side, price_cents, created_at)
  WHERE status IN ('ACCEPTED', 'PARTIALLY_FILLED');

-- --------------------------------------------------------------------------
-- Trades (emparejamientos materializados por el motor)
--
-- El TradeEvent del motor solo trae {buyOrderId, sellOrderId, precio, cantidad}
-- — sin activo, sin usuarios y sin timestamp. Esas columnas se resuelven aquí
-- cruzando contra `orders` por (engine_session_id, engine_order_id).
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trades (
  id                    UUID PRIMARY KEY,
  engine_session_id     UUID NOT NULL REFERENCES engine_sessions(id),

  buy_engine_order_id   BIGINT NOT NULL,
  sell_engine_order_id  BIGINT NOT NULL,

  buy_order_id          UUID REFERENCES orders(id),
  sell_order_id         UUID REFERENCES orders(id),

  asset_id              INTEGER REFERENCES assets(id),
  buyer_user_id         BIGINT  REFERENCES users(id),
  seller_user_id        BIGINT  REFERENCES users(id),

  price_cents           BIGINT  NOT NULL CHECK (price_cents > 0),
  quantity              INTEGER NOT NULL CHECK (quantity > 0),
  gross_amount_cents    BIGINT GENERATED ALWAYS AS (price_cents * quantity) STORED,

  -- Comisión del intermediario (modelo de ingreso del enunciado)
  buyer_fee_cents       BIGINT NOT NULL DEFAULT 0,
  seller_fee_cents      BIGINT NOT NULL DEFAULT 0,

  executed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingested_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotencia: en un libro con prioridad precio-tiempo, un par
-- (orden de compra, orden de venta) se empareja como máximo una vez, porque
-- el emparejamiento agota al menos uno de los dos lados. Esto permite
-- reprocesar el mismo trade sin duplicarlo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trades_pair
  ON trades (engine_session_id, buy_engine_order_id, sell_engine_order_id);

CREATE INDEX IF NOT EXISTS idx_trades_asset_time ON trades (asset_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_buyer      ON trades (buyer_user_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_seller     ON trades (seller_user_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_time       ON trades (executed_at DESC);

-- --------------------------------------------------------------------------
-- Posiciones (portafolio por usuario y activo)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS positions (
  user_id             BIGINT  NOT NULL REFERENCES users(id),
  asset_id            INTEGER NOT NULL REFERENCES assets(id),
  quantity            BIGINT  NOT NULL DEFAULT 0,
  -- Costo promedio ponderado de las acciones en cartera
  avg_cost_cents      BIGINT  NOT NULL DEFAULT 0,
  realized_pnl_cents  BIGINT  NOT NULL DEFAULT 0,
  fees_paid_cents     BIGINT  NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_positions_asset ON positions (asset_id);

-- --------------------------------------------------------------------------
-- Vista: estado de mercado por activo (mejor oferta, mejor demanda, spread)
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW market_state AS
SELECT
  a.id                        AS asset_id,
  a.symbol,
  a.name,
  bids.best_bid_cents,
  asks.best_ask_cents,
  (asks.best_ask_cents - bids.best_bid_cents) AS spread_cents,
  COALESCE(bids.open_orders, 0) AS open_buy_orders,
  COALESCE(asks.open_orders, 0) AS open_sell_orders,
  COALESCE(bids.open_quantity, 0) AS open_buy_quantity,
  COALESCE(asks.open_quantity, 0) AS open_sell_quantity,
  last.last_price_cents,
  last.last_trade_at
FROM assets a
LEFT JOIN LATERAL (
  SELECT MAX(o.price_cents) AS best_bid_cents,
         COUNT(*)           AS open_orders,
         SUM(o.remaining_quantity) AS open_quantity
  FROM orders o
  WHERE o.asset_id = a.id AND o.side = 'BUY'
    AND o.status IN ('ACCEPTED', 'PARTIALLY_FILLED')
) bids ON TRUE
LEFT JOIN LATERAL (
  SELECT MIN(o.price_cents) AS best_ask_cents,
         COUNT(*)           AS open_orders,
         SUM(o.remaining_quantity) AS open_quantity
  FROM orders o
  WHERE o.asset_id = a.id AND o.side = 'SELL'
    AND o.status IN ('ACCEPTED', 'PARTIALLY_FILLED')
) asks ON TRUE
LEFT JOIN LATERAL (
  SELECT t.price_cents AS last_price_cents, t.executed_at AS last_trade_at
  FROM trades t
  WHERE t.asset_id = a.id
  ORDER BY t.executed_at DESC
  LIMIT 1
) last ON TRUE;
