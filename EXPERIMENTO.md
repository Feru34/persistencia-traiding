# Experimento: latencia y escalabilidad en AWS (EC2 + RDS)

**ARTI4109 · Reto 1** — resultado del despliegue real del backend de persistencia
en AWS y de las mediciones de latencia contra los requisitos del enunciado.
Fecha de ejecución: **2026-09-04**. Referencia de diseño: [README.md](README.md).
Traspaso operativo: [PENDIENTES.md](PENDIENTES.md).

---

## 1. Objetivo y requisitos

Comprobar, en una topología real (no en un portátil), que el backend cumple los
requisitos de latencia de registro de órdenes y que ninguna orden ni trade se
pierde bajo la carga del enunciado, comparando las dos estrategias de escritura
a la base de datos (`PERSIST_MODE=async` vs `sync`).

| Requisito del enunciado | Valor |
|---|---|
| Registro de **venta** | p99 < 500 ms |
| Registro de **compra** | p99 < 300 ms |
| Carga sostenida | 500 ventas/min + 800 compras/min = **1300 órdenes/min** |
| Picos | 5000 emparejamientos/min |

---

## 2. Topología desplegada

```
  tu portátil ──SSH/HTTP 3000──▶ EC2 backend (t3.micro, us-east-1b)
                                 172.31.84.127 · Amazon Linux 2023 · Docker
                                 ├── trading-api     :3000  (este backend)
                                 └── trading-bridge         (worker WS → HTTP)
                                          │ REST 8080 (IP privada)      │ WS 8080
                                          ▼                             ▼
                                 EC2 motor (t3.micro, us-east-1b)
                                 172.31.21.117 · Corretto 21 · MatchineEngine.jar
                                          
  EC2 backend ──TLS 5432──▶ RDS PostgreSQL 18.3 (db.t3.micro, us-east-1f)
                            arquisoft-bbdd.cgl68cawebpp.us-east-1.rds.amazonaws.com
                            base `trading` · 20 GB gp2 · 172.31.70.209
```

| Componente | Dónde | Detalle |
|---|---|---|
| Backend (`trading-api`) | EC2 `i-066240bbc580e697d`, t3.micro (2 vCPU, 1 GB) | Imagen `trading-persistence:latest`, `NODE_ENV=production`, `LOG_LEVEL=info` |
| Worker (`trading-bridge`) | Misma EC2, misma imagen | Sostiene el WebSocket del motor y empuja a `POST /api/v1/trades` |
| Motor de matching | EC2 aparte, t3.micro, IP privada `172.31.21.117` | `java -Xmx512m -jar MatchineEngine.jar` con su `application.properties` al lado |
| Base de datos | RDS PostgreSQL **18.3**, Single-AZ | Conexión por `DATABASE_URL`, **TLS obligatorio** (`ssl=true` verificado desde el servidor) |
| Red | Misma VPC `172.31.0.0/16` | Tráfico backend↔motor y backend↔RDS **solo por IP privada** |

### Security groups (lo mínimo que hizo falta)

| Instancia | Entrada | Origen |
|---|---|---|
| EC2 backend (`launch-wizard-1`) | 22, 3000 | IP del operador |
| EC2 motor | **8080** | El SG de la EC2 backend (o `172.31.84.127/32`) |
| RDS | 5432 | El SG de la EC2 backend |

Ni 5432 ni 8080 están abiertos a `0.0.0.0/0`. La regla de 8080 se pone en el SG
del **motor** (es quien escucha), con origen el SG del backend; compartir un mismo
SG entre las dos EC2 también sirve, pero hay que añadir la regla 8080 con origen
**el propio SG**: pertenecer al mismo grupo no autoriza el tráfico por sí solo.

### Por qué el motor va en EC2 y no en Lambda

Se evaluó correr el JAR en Lambda. No encaja: el motor es un proceso con estado
(libro y contador de ids en memoria de la JVM), es un servidor que escucha en
8080 y **sirve** un WebSocket que el bridge mantiene abierto. Lambda es efímero,
sin puertos, se escala en copias con memoria separada (dos motores que nunca se
emparejarían entre sí) y su cold start de Spring Boot son segundos, incompatibles
con un p99 de 300 ms. Es la misma conclusión del diagrama de despliegue
(Motor de Emparejamiento en EC2).

---

## 3. Cómo se levantó

1. **RDS**: instancia creada previamente con base inicial `trading`.
2. **EC2 backend**: `git clone`, Docker, y `.env` (no versionado) con:

   ```bash
   NODE_ENV=production
   PERSIST_MODE=async                 # la variable del experimento
   DATABASE_URL=postgresql://trading:<password>@arquisoft-bbdd...rds.amazonaws.com:5432/trading
   PGSSLMODE=require
   ENGINE_BASE_URL_DOCKER=http://172.31.21.117:8080
   BRIDGE_ENGINE_WS_URL_DOCKER=ws://172.31.21.117:8080/api/trades/stream
   ```

   Con `DATABASE_URL` definido, el compose pone `PGSSLMODE=require` dentro del
   contenedor automáticamente. Sin él, la API intentaba TLS contra el postgres
   local del compose y moría con `The server does not support SSL connections`;
   ese fue el fallo inicial documentado en `PENDIENTES.md` §3.

3. **Arranque** (solo lo necesario; la RDS reemplaza al postgres local):

   ```bash
   docker compose up -d --build api bridge
   curl -s localhost:3000/api/v1/ready    # {"database":"up","engine":"up"}
   ```

   La API aplica las migraciones al arrancar (`001_schema.sql`, `002_seed_assets.sql`).

4. **EC2 motor**: AMI Amazon Linux 2023, 8 GB, sin snapshot de la otra EC2
   (no necesita Docker, el repo ni el `.env` con la contraseña de la RDS):

   ```bash
   scp -i llave.pem MatchineEngine.jar application.properties ec2-user@<ip-publica-motor>:~/
   sudo dnf install -y java-21-amazon-corretto-headless
   nohup java -Xmx512m -jar MatchineEngine.jar > engine.log 2>&1 &
   curl -s localhost:8080/api/estadisticas
   ```

---

## 4. Verificaciones previas a medir

Todas se hicieron **antes de arrancar el motor**, para separar la base del motor.

| Verificación | Cómo | Resultado |
|---|---|---|
| Conexión a la RDS | `GET /api/v1/ready` y `psql` desde la EC2 | `database: up`; host `172.31.70.209`, `ssl=true`, PG 18.3 |
| Migraciones | `schema_migrations` | `001_schema.sql`, `002_seed_assets.sql`; 8 tablas; 5 activos |
| Escritura real | `POST /users` + `POST /users/:id/cash` + lectura | 201 / 200 / 200, saldo persistido |
| Orden sin motor | `POST /orders/buy` con el motor caído | `502 EngineError` y la orden queda **`REJECTED` con el motivo** (no se descarta en silencio) |
| Cola write-behind | `GET /metrics` tras lo anterior | El rechazo llegó a la RDS vía la cola: `flushed` > 0, `failures: 0` |
| Punta a punta (con motor) | venta 10@50.25 + compra 4@51.00 | 1 trade, `buyerUserId: 2`, `sellerUserId: 1`, precio 50.25, fee 0.50 por lado |

---

## 5. Protocolo de medición

- Generador: `scripts/loadtest.js`, ejecutado **en la EC2 del backend** dentro de
  la imagen (la EC2 no tiene Node instalado):

  ```bash
  docker compose run --rm --no-deps -T api \
    node scripts/loadtest.js --url http://api:3000 --rate 1300 --duration 60
  ```

- Mezcla 800 compras / 500 ventas por minuto, precios y activos aleatorios,
  usuarios creados al vuelo (`AUTO_CREATE_USERS=true`, `ENFORCE_BALANCES=false`).
- **Se descarta una corrida de calentamiento de 20 s** antes de cada medición
  (JIT del motor y de Node), como indica `PENDIENTES.md` §5.
- Tras cada corrida: `GET /metrics` (la cola debe volver a 0) y
  `POST /admin/reconcile?repair=true` (no debe haber deriva contra el libro del motor).
- Cambio de modo: `PERSIST_MODE` en `.env` + `docker compose up -d --force-recreate api`.
- `LOG_LEVEL=info` en todas las corridas.

---

## 6. Resultados

### 6.1 Latencia de registro a 1300 órdenes/min durante 60 s

| Modo | Órdenes ok / fallidas | Throughput | **Venta p99** | **Compra p99** | p50 | p95 | máx |
|---|---|---|---|---|---|---|---|
| `async` (write-behind) | 1298 / **0** | 1298/min | **19.1 ms** ✅ | **18.9 ms** ✅ | 6.7 ms | 12.6 ms | 97 ms |
| `sync` (escribe antes de responder) | 1298 / **0** | 1298/min | **44.9 ms** ✅ | **47.6 ms** ✅ | 13.8 ms | 22 ms | 208 ms |

Ambos modos cumplen los requisitos con más de un orden de magnitud de margen.
`sync` cuesta aproximadamente **2× en latencia** (un round-trip adicional a la
RDS por orden), que es exactamente lo que predice el diseño; a cambio, la orden
queda escrita antes de responder y no hay nada en memoria que perder ante una caída.

Detalle de la corrida de calentamiento (descartada, se incluye por transparencia):
async venta p99 17.4 ms / compra 20.6 ms; sync venta p99 75.2 ms / compra 33.0 ms.

### 6.2 Cola write-behind e integridad (modo `async`)

| Métrica | Valor |
|---|---|
| Elementos encolados / vaciados | 2217 / 2217 |
| Lotes | 1832 |
| Profundidad máxima de la cola | **18** de 100 000 |
| Lotes fallidos / dead-letter / conflictos de sesión / duplicados | **0 / 0 / 0 / 0** |
| Saturación (`503` por backpressure) | nunca |

### 6.3 Reconciliación contra el libro del motor

| Tras la corrida | Órdenes comprobadas | Libro del motor | Deriva | Reparadas | Cantidad sin justificar |
|---|---|---|---|---|---|
| `async` | 1233 | 1233 | 0 | 0 | 0 |
| `sync` | 2743 | 2743 | 0 | 0 | 0 |

`"Sin discrepancias."` en ambos casos: el backend y el motor coinciden orden por orden.

### 6.4 Contabilidad

Al final del experimento (3463 órdenes, 700 trades en la sesión):

- **700 de 700 trades con ambos lados resueltos** (comprador y vendedor identificados
  cruzando `(engine_session_id, engine_order_id)` con las órdenes guardadas).
- **Suma de cantidades de todas las posiciones = 0**: cada acción comprada fue
  vendida por alguien. La contabilidad cuadra.

### 6.5 Comparación con la medición en portátil (README)

| | Portátil (todo en una máquina) | AWS (esta medición, `async`) |
|---|---|---|
| Venta p99 | 274 ms | **19 ms** |
| Compra p99 | 139 ms | **19 ms** |
| Mediana | ~10 ms | ~7 ms |

La mejora viene de separar el motor: en el portátil su espera activa (~2 vCPU
al 100 %) competía con el backend, la base y el generador. En AWS el backend y
la RDS solo comparten CPU con el generador de carga.

---

## 7. Endpoint de estado añadido: `GET /api/v1/status`

Durante el despliegue hacía falta mirar `/ready`, `/metrics` y los logs para
saber contra qué base se estaba conectado. Se añadió una vista consolidada
(`src/services/statusService.js`):

```jsonc
{
  "overall": "ok",                       // ok | degraded | down
  "service":  { "version": "1.0.0", "env": "production", "persistMode": "async", "uptimeSeconds": 26 },
  "database": { "status": "up", "latencyMs": 3, "host": "172.31.70.209/32", "ssl": true,
                "serverVersion": "18.3", "migrations": { "applied": 2, "last": "002_seed_assets.sql" },
                "counts": { "users": 5, "orders": 3463, "trades": 700, "sessionOrders": 3463, "sessionTrades": 700 } },
  "engine":   { "status": "up", "baseUrl": "http://172.31.21.117:8080", "latencyMs": 4, "stats": { /* del motor */ } },
  "session":  { "id": "01a06d57-…", "startedAt": "…" },
  "persistence": { "mode": "async", "queueDepth": 0, "saturated": false, "deadLettered": 0, "conflicts": 0 },
  "pool": { "total": 1, "idle": 1, "waiting": 0 }
}
```

- `overall` es `down` si la base no responde; `degraded` si el motor está caído,
  la cola saturada o hay lotes en dead-letter; `ok` en otro caso.
- **Siempre responde 200**: es informativo. El balanceador debe seguir usando
  `/ready`, que sí devuelve `503` cuando la base cae.
- El host y el TLS los reporta el propio servidor PostgreSQL
  (`inet_server_addr()`, `pg_stat_ssl`), no la configuración: así se detecta
  estar conectado a la base equivocada.
- Cubierto por `test/status.test.js` (semáforo `overall`).

---

## 8. Endpoints de la persistencia (todos, prefijo `/api/v1`)

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/orders/sell` | Registra una oferta de **venta** y la inyecta en el motor |
| `POST` | `/orders/buy` | Registra una oferta de **compra** y la inyecta en el motor |
| `POST` | `/orders` | Igual, con `side` (`BUY`/`SELL`) en el cuerpo |
| `GET` | `/orders` | Lista con filtros `userId`, `assetId`, `side`, `status`, `open`, `limit`, `offset` |
| `GET` | `/orders/:id` | Una orden |
| `DELETE` | `/orders/:id` | Cancela en este registro (el motor no soporta cancelación) |
| `POST` | `/trades` | **Ingesta** de trades del motor (uno o un arreglo), idempotente. Cabecera `X-Ingest-Token` |
| `GET` | `/trades` | Lista con filtros `assetId`, `userId`, `since`, `until` |
| `GET` | `/trades/:id` | Un trade |
| `GET` | `/assets` | Los 5 activos que admite el motor |
| `GET` | `/market` | Mejor compra/venta, spread, profundidad y último precio de cada activo |
| `GET` | `/market/summary` | OHLC, volumen, monto y comisiones (`?assetId=&since=`) |
| `GET` | `/market/:assetId` | Estado de mercado de un activo |
| `GET` | `/market/:assetId/book` | Libro agregado por nivel de precio (`?depth=20`) |
| `POST` | `/users` | Crea o actualiza un usuario |
| `GET` | `/users` | Lista de usuarios |
| `GET` | `/users/:id` | Un usuario con su saldo |
| `POST` | `/users/:id/cash` | Depósito (`amount > 0`) o retiro (`amount < 0`) |
| `GET` | `/users/:id/positions` | Portafolio: cantidad, costo promedio, valor de mercado y P&L |
| `GET` | `/health` | Liveness: el proceso está vivo |
| `GET` | `/ready` | Readiness para el balanceador: `503` si la base no responde |
| `GET` | `/status` | **Estado consolidado** (base, motor, sesión, cola, conteos); siempre `200` |
| `GET` | `/metrics` | Cola write-behind, pool y configuración activa |
| `GET` | `/engine/stats` | Proxy de las estadísticas en vivo del motor |
| `GET` | `/engine/book` | Proxy del libro en vivo del motor |
| `POST` | `/engine/match` | Fuerza un ciclo de emparejamiento |
| `POST` | `/engine/reset` | Reinicia el motor **y rota la sesión** |
| `GET` | `/sessions` | Sesiones del motor con sus conteos |
| `GET` | `/admin/reconcile` | Compara con el libro del motor (solo informa) |
| `POST` | `/admin/reconcile` | Lo mismo; con `?repair=true` corrige cantidades ejecutadas |
| `POST` | `/admin/flush` | Vacía la cola de escritura ya |

Documentación interactiva: `http://<ip-backend>:3000/docs` (Swagger UI) y
`/docs/json` (OpenAPI 3.1), generadas de los mismos esquemas que validan las peticiones.

---

## 9. Consideraciones, límites y hallazgos

- **El generador de carga corrió en la EC2 del backend**, compitiendo por sus
  2 vCPU. Los números son por tanto conservadores; en un despliegue con el
  generador fuera serían iguales o mejores. Nunca se corrió en la EC2 del motor.
- **Zonas de disponibilidad**: las dos EC2 están en `us-east-1b` y la RDS en
  `us-east-1f`. `PENDIENTES.md` §5 recomienda la misma AZ; aun con el salto
  entre AZ la latencia a la base fue de ~3 ms y los requisitos sobran. Para
  una medición más fina, crear las EC2 en `us-east-1f`.
- **CPU del motor**: consume ~2 vCPU al 100 % en reposo (espera activa). Por
  eso va en instancia aparte y en modo `unlimited`; ese es el único coste
  esperable fuera de la capa gratuita (~0,09 USD/h mientras corre).
- **Capa gratuita**: 750 h/mes de EC2 **compartidas** entre las dos instancias
  (cuentas anteriores a julio de 2025); 30 GB de EBS en total (10 + 8 usados);
  RDS con sus propias 750 h y 20 GB. Apagar las EC2 entre sesiones.
- **`trades.wal`**: el motor escribe un archivo `trades.wal` junto al JAR. La
  documentación asumía que no persistía nada («sin búfer de reenvío»). Puede
  servir para reconstruir trades perdidos mientras el bridge estaba caído,
  el único hueco de datos conocido. Pendiente de analizar.
- **Datos de prueba en la RDS**: usuario `9001` (verificación de escritura) y
  las ~3400 órdenes / 700 trades del loadtest, todos en la sesión
  `01a06d57-3aa0-7822-ad22-e92afc56d1a8`. Para partir limpio,
  `POST /api/v1/engine/reset` rota la sesión sin borrar historial.

---

## 10. Reproducir el experimento

```bash
# en la EC2 del backend, con el motor arriba y /ready → engine: up
docker compose run --rm --no-deps -T api node scripts/loadtest.js --url http://api:3000 --rate 1300 --duration 20   # calentamiento
docker compose run --rm --no-deps -T api node scripts/loadtest.js --url http://api:3000 --rate 1300 --duration 60   # medición
curl -s localhost:3000/api/v1/metrics
curl -s -X POST 'localhost:3000/api/v1/admin/reconcile?repair=true'

# cambiar de hipótesis
sed -i 's/^PERSIST_MODE=.*/PERSIST_MODE=sync/' .env
docker compose up -d --force-recreate api
# ... repetir; y volver a async al terminar
```

Checklist de cierre de `PENDIENTES.md` §8: **6 de 6** ✅.
