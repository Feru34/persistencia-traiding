# Backend de Persistencia de Trading

**ARTI4109 · Arquitectura de Software · Reto 1: Latencia y Escalabilidad**
Maestría en Arquitecturas de TI (MATI) — Universidad de los Andes

Backend en Node.js responsable **únicamente de la persistencia** de un sistema de
trading. Registra ofertas de compra y de venta, guarda los emparejamientos que
produce el motor y responde por el estado de las acciones, las órdenes, las
posiciones y las comisiones.

> **El matching NO ocurre aquí.** La lógica de emparejamiento corre en otra
> máquina (`MatchineEngine.jar`). Este servicio inyecta las órdenes en ese motor
> y persiste todo lo que pasa, pero nunca decide qué se empareja con qué.

---

## Índice

- [Alcance y decisiones de diseño](#alcance-y-decisiones-de-diseño)
- [Arquitectura](#arquitectura)
- [Contrato del motor de matching](#contrato-del-motor-de-matching)
- [Puesta en marcha](#puesta-en-marcha)
- [Docker](#docker)
- [Variables de entorno](#variables-de-entorno)
- [Documentación de la API (Swagger)](#documentación-de-la-api-swagger)
- [API](#api)
- [Modelo de datos](#modelo-de-datos)
- [Modo `async` vs `sync`](#modo-async-vs-sync)
- [Un hueco real: los trades se pueden perder](#un-hueco-real-los-trades-se-pueden-perder)
- [Resultados de carga](#resultados-de-carga)
- [Operación](#operación)
- [Pruebas](#pruebas)

---

## Alcance y decisiones de diseño

Estas cuatro decisiones se acordaron antes de escribir el código. Se dejan
documentadas con las alternativas que se descartaron, porque condicionan toda
la arquitectura.

### 1. Rol del backend frente al motor

| Opción | Descripción |
|---|---|
| **✅ Gateway + persistencia** | Recibe la orden del cliente, la persiste y la reenvía al motor guardando el ID que devuelve. Un solo punto de entrada; el backend es dueño del estado completo. |
| ❌ Solo persistencia | El backend nunca llama al motor; otro componente lo hace. Más puro, pero exige un servicio adicional para que el flujo funcione. |

### 2. Cómo llegan los trades ejecutados

| Opción | Descripción |
|---|---|
| **✅ Endpoint HTTP push** | `POST /api/v1/trades`, donde un worker externo empuja los emparejamientos. Acepta lotes y es idempotente. |
| ❌ WebSocket del motor | Que el backend se suscriba directamente a `ws://motor/api/trades/stream`. |
| ❌ Kafka / Amazon MSK | Como en el diagrama de despliegue. Requiere un bróker corriendo. |

> El motor **solo** publica por WebSocket, así que se incluye
> [`scripts/bridge.js`](scripts/bridge.js): un proceso aparte que escucha ese
> stream y lo empuja al endpoint HTTP. Es el «Worker de Persistencia» del
> diagrama y permite cerrar el ciclo hoy, sin infraestructura extra. Si más
> adelante entra MSK, se reemplaza el bridge y **el backend no cambia**.

### 3. Estrategia de escritura a la RDS

| Opción | Descripción |
|---|---|
| **✅ Async por lotes, configurable** | Write-behind con batching: la persistencia sale del camino crítico (el «JDBC upsert (batch)» del diagrama). `PERSIST_MODE=sync\|async` permite medir ambas hipótesis. |
| ❌ Síncrono siempre | Cada request escribe antes de responder. Más simple y durable, pero suma latencia. |

### 4. Alcance del modelo de negocio

| Opción | Descripción |
|---|---|
| **✅ Órdenes + trades + posiciones** | Incluye portafolio por usuario (cuántas acciones tiene de cada activo, costo promedio, P&L) y comisiones del intermediario. |
| ❌ Solo órdenes y trades | Registro puro, sin portafolio. |

---

## Arquitectura

```
   Cliente de Trading
          │  HTTP/JSON
          ▼
┌───────────────────────────────┐        ┌──────────────────────────┐
│  ESTE BACKEND (Node.js)       │ REST   │  MOTOR DE MATCHING       │
│  Gateway + Persistencia       │───────▶│  MatchineEngine.jar      │
│                               │        │  · libro en memoria      │
│  · valida y registra órdenes  │        │  · empareja              │
│  · resuelve activo/usuarios   │        └──────────┬───────────────┘
│  · calcula posiciones y fees  │                   │ WebSocket
│  · escritor write-behind      │                   │ (sin reenvío)
└───────┬───────────────────────┘                   ▼
        │ INSERT por lotes                ┌──────────────────────┐
        ▼                                 │  scripts/bridge.js   │
┌────────────────────┐   POST /trades     │  Worker de           │
│  RDS PostgreSQL    │◀───────────────────│  Persistencia        │
└────────────────────┘                    └──────────────────────┘
```

Correspondencia con el `Diagrama Despliegue.png`:

| Diagrama | Aquí |
|---|---|
| Order Gateway (ECS Fargate) | Rutas `POST /api/v1/orders/*` |
| Motor de Emparejamiento (EC2) | `MatchineEngine.jar`, en otra máquina |
| Worker de Persistencia (ECS Fargate) | `scripts/bridge.js` + `POST /api/v1/trades` |
| Amazon MSK | Sustituido por el bridge WS→HTTP (ver [el hueco](#un-hueco-real-los-trades-se-pueden-perder)) |
| Aurora PostgreSQL | La RDS del `.env` |
| JDBC upsert (batch) | `BatchWriter` en [`src/services/persistence.js`](src/services/persistence.js) |

### Estructura

```
src/
├── config/          Configuración desde entorno (incluye SSL de RDS)
├── db/              Pool de conexiones, migraciones, helpers de SQL
├── domain/          Constantes del motor, dinero en centavos, UUIDv7
├── repositories/    Acceso a datos (inserciones por lotes)
├── services/        Lógica: órdenes, trades, persistencia, sesiones, reconciliación
└── routes/          Endpoints HTTP (Fastify)
scripts/
├── bridge.js              Worker WS del motor → HTTP de este backend
├── loadtest.js            Valida los requisitos de latencia del enunciado
├── replay-dead-letter.js  Reprocesa lotes que no se pudieron escribir
└── seed.js                Usuarios de prueba
sql/                Esquema y datos base (migraciones idempotentes)
```

---

## Contrato del motor de matching

Verificado **ejecutando el JAR** y observando su API real, no por suposición:

| Endpoint | Descripción |
|---|---|
| `POST /api/ordenes` | `{idUsuario, idActivo, tipo, precio, cantidad}` → `202 "Orden inyectada correctamente con ID: N"` |
| `POST /api/emparejar` | Dispara un ciclo de emparejamiento |
| `POST /api/reset` | Borra libros, memoria y estadísticas |
| `GET /api/estadisticas` | Órdenes en compra/venta, trades, contadores |
| `GET /api/libro` | Órdenes vivas con `cantidadRestante` |
| `WS /api/trades/stream` | `{buyOrderId, sellOrderId, precio, cantidad}` |

Detalles que condicionan el diseño:

- **`tipo: 0` = COMPRA, `tipo: 1` = VENTA.** Confirmado ejecutando el motor.
- **`idActivo` debe estar entre 0 y 4**, si no responde `400`.
- El motor devuelve el ID **en texto plano**, no en JSON: hay que extraerlo.
- Responde `503` con «Pool de memoria agotado» o «buffer de entrada lleno»
  cuando se satura. Es reintentable y así lo trata el cliente.
- **El `TradeEvent` no trae activo, ni usuarios, ni marca de tiempo.** Solo los
  dos IDs de orden. Por eso este backend cruza cada trade contra las órdenes
  guardadas para reconstruir quién compró qué. Es la razón de ser del índice
  `(engine_session_id, engine_order_id)`.
- El motor **no valida saldos ni tenencias**, y **no soporta cancelación**.

### Sesiones del motor

El contador de IDs del motor vuelve a 1 cuando se reinicia la JVM. Sin
aislarlo, la orden `#1` de hoy se confundiría con la `#1` de ayer y los trades
se asociarían a la orden equivocada. Cada ejecución del motor es una **sesión**
(`engine_sessions`), y las órdenes son únicas por `(sesión, id del motor)`.

Al arrancar, el backend consulta el motor y **reanuda** la sesión anterior si el
motor conserva su libro; solo abre una sesión nueva si el motor realmente
empezó de cero. Además sondea el motor y rota la sesión sola si detecta que el
contador retrocedió.

---

## Puesta en marcha

### Requisitos

- Node.js ≥ 20
- PostgreSQL (RDS, o el Docker de abajo para desarrollo)
- El motor `MatchineEngine.jar` corriendo (Java 17+)

### Pasos

```bash
# 1. Dependencias
npm install

# 2. Configuración — aquí van las credenciales de la RDS
cp .env.example .env
$EDITOR .env

# 3. Base de datos local (omitir si ya se apunta a la RDS)
docker compose up -d

# 4. Esquema + activos base (idempotente)
npm run migrate

# 5. Usuarios de prueba con saldo (opcional)
npm run seed

# 6. Motor de matching, en su máquina
java -jar MatchineEngine.jar

# 7. Backend
npm start

# 8. Worker que lleva los trades del motor a la persistencia
npm run bridge
```

Comprobación rápida (o abrir <http://localhost:3000/docs> y probar desde ahí):

```bash
curl localhost:3000/api/v1/ready
curl -X POST localhost:3000/api/v1/orders/sell -H 'Content-Type: application/json' \
  -d '{"userId":1,"assetId":2,"price":50.25,"quantity":10}'
curl -X POST localhost:3000/api/v1/orders/buy -H 'Content-Type: application/json' \
  -d '{"userId":2,"assetId":2,"price":51.00,"quantity":4}'
curl localhost:3000/api/v1/trades
```

### Conectarse a la RDS

En `.env`, o bien `DATABASE_URL`, o bien los parámetros sueltos. **`PGSSLMODE`
importa**: RDS exige TLS.

```bash
PGSSLMODE=require   # TLS sin validar la CA — lo habitual contra RDS
PGSSLMODE=verify    # TLS validando la CA; requiere PGSSLROOTCERT
PGSSLMODE=disable   # solo para el Docker local
```

Para `verify`, descargar el bundle de AWS:

```bash
curl -o certs/rds-ca.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

---

## Docker

Todo el stack está contenedorizado para Linux. La imagen es multi-etapa sobre
`node:22-alpine`, corre como usuario sin privilegios, lleva `tini` como PID 1
(para que el `SIGTERM` llegue de verdad y el apagado ordenado vacíe la cola) y
trae `HEALTHCHECK` propio. El contexto de build son ~180 KB: el JAR, el PDF y
el diagrama quedan fuera por `.dockerignore`.

| Servicio | Contenedor | Qué es |
|---|---|---|
| `postgres` | `trading-postgres` | PostgreSQL 16 local. Con RDS, sobra |
| `api` | `trading-api` | Este backend, en `:3000`. Aplica migraciones al arrancar |
| `bridge` | `trading-bridge` | Worker WS→HTTP. Misma imagen, otro comando |
| `engine` | `trading-engine` | El motor, **solo con `--profile engine`**. Monta el JAR desde el host |

```bash
# Stack local completo con el motor incluido
docker compose --profile engine up -d --build
docker compose logs -f api bridge

# Sin el motor (porque corre en otra máquina): define ENGINE_BASE_URL_DOCKER
# y BRIDGE_ENGINE_WS_URL_DOCKER en .env y omite el perfil
docker compose up -d --build

# Apagar (añadir -v para borrar también los datos de postgres)
docker compose --profile engine down
```

También como scripts: `npm run docker:up`, `docker:up:engine`, `docker:logs`,
`docker:down`.

### Contra la RDS real

Pon `DATABASE_URL` y `PGSSLMODE=require` en `.env` y levanta solo lo que hace
falta:

```bash
docker compose up -d --build api bridge
```

`DATABASE_URL` tiene prioridad sobre `PGHOST`/`PGPORT`, así que el `postgres`
del compose queda sin uso aunque exista.

### Por qué hay variables `*_DOCKER`

Dentro de un contenedor `localhost` es el propio contenedor. Las variables del
`.env` que apuntan a `localhost` (`PGHOST`, `ENGINE_BASE_URL`, las del bridge)
no sirven ahí, así que el compose las sobreescribe con `PGHOST_DOCKER`,
`ENGINE_BASE_URL_DOCKER`, etc., que por defecto apuntan a los servicios del
compose. Solo hay que definirlas cuando algo vive fuera — típicamente el motor
en su EC2. El `.env.example` las documenta al final.

### Imagen suelta, sin compose

```bash
docker build -t trading-persistence .
docker run --rm -p 3000:3000 --env-file .env \
  -e PGHOST=host.docker.internal -e ENGINE_BASE_URL=http://host.docker.internal:8080 \
  trading-persistence
```

Al detener el contenedor, darle margen: `docker stop -t 30`. El compose ya lo
fija con `stop_grace_period: 30s`.

---

## Variables de entorno

Todas están documentadas en [`.env.example`](.env.example). Las que más pesan:

| Variable | Por defecto | Para qué sirve |
|---|---|---|
| `PERSIST_MODE` | `async` | `async` = write-behind por lotes; `sync` = escribe antes de responder |
| `BATCH_SIZE` | `500` | Filas por lote. Más grande = menos round-trips, más exposición ante una caída |
| `BATCH_INTERVAL_MS` | `25` | Cada cuánto se vacía la cola aunque no esté llena |
| `BATCH_MAX_QUEUE` | `100000` | Tope de la cola; al superar el 90 % se responde `503` |
| `ENGINE_BASE_URL` | `http://localhost:8080` | Dónde vive el motor |
| `ENGINE_HEALTH_POLL_MS` | `5000` | Sondeo que detecta reinicios del motor |
| `FEE_BPS` | `25` | Comisión en puntos básicos (25 = 0.25 %) por lado |
| `ENFORCE_BALANCES` | `false` | Validar saldo/tenencias antes de aceptar (el motor no lo hace) |
| `INGEST_TOKEN` | vacío | Token de `X-Ingest-Token` para `POST /trades` |

---

## Documentación de la API (Swagger)

Con el backend arriba, la documentación interactiva está en:

- **<http://localhost:3000/docs>** — Swagger UI: cada endpoint con su formato de
  entrada, su formato de salida, ejemplos, y un botón *Try it out* para
  llamarlo desde el navegador.
- **<http://localhost:3000/docs/json>** — la especificación OpenAPI 3.1 en
  crudo, para importar en Postman, Insomnia o generar un cliente.

La especificación **se deriva de los mismos esquemas que validan las
peticiones** ([`src/routes/schemas.js`](src/routes/schemas.js) y cada archivo
de rutas), así que el contrato publicado no puede desincronizarse del que se
aplica de verdad: si un campo cambia, cambia en los dos sitios a la vez.

Los formatos principales son los componentes `Order`, `Trade`, `TradeIngest`
(lo que emite el motor), `Position`, `User`, `MarketState`, `BookLevel` y
`AssetSummary`.

---

## API

Prefijo: `/api/v1` — la referencia completa y probable está en [`/docs`](#documentación-de-la-api-swagger).

### Órdenes

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/orders/sell` | Registra una **oferta de venta** |
| `POST` | `/orders/buy` | Registra una **oferta de compra** |
| `POST` | `/orders` | Igual, con `side` en el cuerpo |
| `GET` | `/orders` | Lista. Filtros: `userId`, `assetId`, `side`, `status`, `open`, `limit`, `offset` |
| `GET` | `/orders/:id` | Una orden |
| `DELETE` | `/orders/:id` | Cancela **en este registro** (el motor no soporta cancelación) |

```jsonc
// POST /api/v1/orders/sell
{
  "userId": 1,
  "assetId": 2,
  "price": 50.25,
  "quantity": 10,
  "clientOrderId": "mi-id-unico"   // opcional: hace el reintento idempotente
}
```

### Trades

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/trades` | **Ingesta**. Un objeto o un arreglo. Cabecera `X-Ingest-Token` |
| `GET` | `/trades` | Lista. Filtros: `assetId`, `userId`, `since`, `until` |
| `GET` | `/trades/:id` | Un trade |

### Estado del mercado

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/assets` | Activos disponibles |
| `GET` | `/market` | Mejor compra/venta, spread, profundidad y último precio de cada activo |
| `GET` | `/market/:assetId` | Lo mismo para un activo |
| `GET` | `/market/:assetId/book` | Libro agregado por nivel de precio (`?depth=20`) |
| `GET` | `/market/summary` | OHLC, volumen, monto y comisiones (`?assetId=&since=`) |

### Usuarios y portafolio

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/users` | Crea o actualiza un usuario |
| `GET` | `/users` · `/users/:id` | Consulta |
| `POST` | `/users/:id/cash` | Depósito (`amount > 0`) o retiro (`amount < 0`) |
| `GET` | `/users/:id/positions` | **Portafolio**: cantidad, costo promedio, valor de mercado y P&L |

### Operación

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` · `/ready` | Liveness y readiness (este último toca RDS y motor) |
| `GET` | `/metrics` | Cola de escritura, pool de conexiones y configuración activa |
| `GET` | `/engine/stats` · `/engine/book` | Estado **en vivo** del motor |
| `POST` | `/engine/match` | Fuerza un ciclo de emparejamiento |
| `POST` | `/engine/reset` | Reinicia el motor **y rota la sesión** |
| `GET` | `/sessions` | Sesiones del motor con sus conteos |
| `POST` | `/admin/flush` | Vacía la cola de escritura ya |
| `GET`/`POST` | `/admin/reconcile` | Compara con el libro del motor; `?repair=true` corrige |

> Usar `POST /api/v1/engine/reset` y **no** un `curl` directo al motor: el reset
> deja su estado en blanco, y sin rotar la sesión los trades nuevos se
> asociarían a órdenes viejas.

---

## Modelo de datos

Todo el dinero se guarda en **centavos** (`BIGINT`), igual que el motor
(`precioCentavos`), para no arrastrar errores de punto flotante. La API expone
decimales.

| Tabla | Contenido |
|---|---|
| `engine_sessions` | Una fila por ejecución del motor. Aísla sus IDs de orden |
| `assets` | Los 5 activos que admite el motor (0–4) |
| `users` | Traders con saldo en efectivo. El `id` lo asigna el cliente |
| `orders` | Ofertas de compra y venta, con lo ejecutado y su estado |
| `trades` | Emparejamientos materializados, con comisiones |
| `positions` | Portafolio: cantidad, costo promedio y P&L realizado |
| `market_state` | *(vista)* Mejor compra/venta, spread y último precio |

Decisiones que conviene conocer antes de tocar el esquema:

- **`orders.id` y `trades.id` son UUIDv7 generados en la aplicación**, no en la
  base. En modo `async` hay que responderle al cliente antes de que ocurra el
  `INSERT`. Al ser ordenados en el tiempo, conservan la localidad del índice
  B-tree y evitan la fragmentación de un UUIDv4.
- **Idempotencia por índices únicos**: `(sesión, id del motor)` en órdenes y
  `(sesión, orden de compra, orden de venta)` en trades. Reenviar un lote no
  duplica nada, porque en un libro con prioridad precio-tiempo un par
  comprador/vendedor se empareja como máximo una vez.
- **Solo los trades realmente insertados** mueven órdenes, posiciones y saldos.
  Un reenvío no vuelve a descontar acciones ni dinero.

---

## Modo `async` vs `sync`

`PERSIST_MODE` cambia dónde queda la escritura respecto del camino crítico. Es
la palanca para medir las dos hipótesis del reto.

|  | `async` (por defecto) | `sync` |
|---|---|---|
| Flujo | Inyecta al motor → responde → escribe por lotes | Escribe `PENDING` → inyecta al motor → confirma |
| Escrituras por orden | 1, amortizada en el lote | 2 |
| Latencia | Menor: no espera a la RDS | Mayor: dos round-trips |
| Si el proceso muere | Se puede perder lo que estaba en la cola | La orden ya quedó registrada |
| Equivale a | «JDBC upsert (batch)» del diagrama | Escritura tradicional |

En modo `async` el apagado es ordenado: ante `SIGTERM` deja de recibir tráfico,
vacía la cola y luego cierra el pool. Si un lote no se puede escribir tras los
reintentos, va a `logs/dead-letter.ndjson` en vez de perderse.

---

## Un hueco real: los trades se pueden perder

**El motor publica los emparejamientos por WebSocket sin ningún búfer de
reenvío.** Si el consumidor está caído en el instante del trade, ese evento se
pierde para siempre: el motor no lo repite y no expone historial de trades.

Esto se comprobó en la práctica durante el desarrollo: con el worker detenido,
el motor emparejó 3 operaciones que **no** llegaron a la base de datos, aunque
las órdenes sí estaban registradas.

Es exactamente el hueco que tapa **Amazon MSK** en el diagrama de despliegue: el
bróker retiene los eventos hasta que alguien los consume. Mientras no esté MSK,
hay dos mitigaciones en el código:

1. **El bridge reintenta y no descarta**: ante un `503` del backend devuelve el
   lote a su cola.
2. **Reconciliación** — `POST /api/v1/admin/reconcile?repair=true`. Compara
   nuestras órdenes con `GET /api/libro` del motor y corrige las cantidades
   ejecutadas que se hayan desfasado.

> **Límite deliberado de la reconciliación:** repara el estado de las
> **órdenes**, pero **no inventa trades**. El motor no dice contra quién se
> emparejó cada orden, así que un trade perdido no se puede reconstruir y las
> posiciones y saldos quedan incompletos para ese volumen. El informe devuelve
> `unaccountedQuantity` justamente para que esa brecha sea visible y no
> silenciosa.

---

## Resultados de carga

Medido con `scripts/loadtest.js`. **Todo corriendo en un solo portátil**: el
backend, el motor, PostgreSQL y el generador de carga compiten por la misma
CPU, así que los números absolutos son conservadores frente a un despliegue real.

### Carga normal del enunciado (500 ventas/min + 800 compras/min)

```
node scripts/loadtest.js --rate 1300 --duration 30
```

| Métrica | Resultado | Requisito | |
|---|---|---|---|
| Throughput sostenido | 1294 órdenes/min | 1300 | ✅ |
| Registro de **venta** (p99) | 274 ms | < 500 ms | ✅ |
| Registro de **compra** (p99) | 139 ms | < 300 ms | ✅ |
| Errores | 0 | | ✅ |

Las medianas quedaron en ~10 ms para ambos lados.

### Saturación (10× la carga requerida)

```
node scripts/loadtest.js --orders 5000 --concurrency 100
```

| Métrica | Resultado |
|---|---|
| Throughput | 209 órdenes/s (**12 555/min**) |
| Órdenes perdidas o descartadas | **0** |
| Lotes fallidos / dead letter | **0** |
| Profundidad máxima de la cola | 261 de 100 000 |
| Latencia p99 | ~2.5 s (fuera del SLO) |

**Dónde se va la latencia:** midiendo el motor **directamente** con la misma
concurrencia (100), el motor solo ya da p50 = 191 ms y p99 = 466 ms. Es decir,
buena parte de la latencia bajo saturación es del motor y de la contención de
CPU del portátil, no de la persistencia. El escritor por lotes nunca fue el
cuello de botella: vació 5647 elementos en 628 lotes sin una sola falla y con
la cola casi vacía.

### Integridad bajo carga

Con 600 órdenes cruzadas y el worker activo: **65 trades persistidos, los 65 con
ambos lados resueltos**, y la suma de cantidades de todas las posiciones igual a
**0** — es decir, cada compra tiene su venta. La contabilidad cuadra.

---

## Operación

```bash
# Estado de la cola de escritura, el pool y la configuración
curl localhost:3000/api/v1/metrics

# Detectar desfases contra el motor (sin tocar nada)
curl localhost:3000/api/v1/admin/reconcile

# Corregirlos
curl -X POST 'localhost:3000/api/v1/admin/reconcile?repair=true'

# Reprocesar lotes que no se pudieron escribir
node scripts/replay-dead-letter.js
```

### Despliegue

La imagen y el compose están descritos en [Docker](#docker). El servicio aplica sus migraciones al arrancar (son idempotentes), así que en
ECS/Fargate no hace falta un paso previo. Para el balanceador, usar
`/api/v1/ready`: comprueba la RDS y el motor, y devuelve `503` si la base no
responde. Un motor caído **no** marca el servicio como no disponible —- las
consultas y la persistencia siguen funcionando; solo se bloquean las órdenes nuevas.

Ante `SIGTERM` el apagado es ordenado: deja de recibir tráfico, vacía la cola de
escritura y cierra el pool. Dar al contenedor un `stopTimeout` holgado
(≥ 30 s) para que ese vaciado alcance a completarse.

---

## Pruebas

```bash
npm test
```

Cubren la conversión de dinero a centavos (incluido el caso `1.15` que el
truncamiento de Java convertiría en `1.14`), la generación y monotonía de los
UUIDv7, el contrato `tipo 0 = COMPRA / 1 = VENTA` verificado contra el JAR, y la
matemática de posiciones: costo promedio ponderado, P&L realizado y ventas en
corto.
