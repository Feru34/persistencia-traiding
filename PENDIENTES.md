# PENDIENTES — despliegue en EC2 y experimentos de latencia

> **Para quien lea esto (persona o Claude Code en la EC2):** este archivo es el
> traspaso de contexto y las tareas abiertas. El mapa de la documentación está
> en [CLAUDE.md](CLAUDE.md); la referencia del proyecto es el
> [README.md](README.md) y el despliegue en AWS, [INFRA.md](INFRA.md).
> Fecha del traspaso: 2026-09-04.

## 1. Qué es esto en cinco líneas

Backend Node.js de **persistencia** de trading (Reto 1, ARTI4109). Registra
órdenes, las inyecta en un **motor de matching externo** (`MatchineEngine.jar`,
Spring Boot, puerto 8080) y persiste en PostgreSQL (RDS) lo que ocurre.
**El matching NO vive aquí.** Un worker aparte (`scripts/bridge.js`) escucha
el WebSocket del motor y empuja los trades a `POST /api/v1/trades`.

## 2. Situación actual

- Repo clonado en la EC2 (`ec2-user@ip-172-31-84-127`, dir `persistencia-traiding`).
- `docker compose up -d --build` construye bien, pero **`trading-api` muere al
  arrancar** y Compose dice `dependency failed to start: container trading-api is unhealthy`.
- RDS PostgreSQL ya creada: `arquisoft-bbdd.cgl68cawebpp.us-east-1.rds.amazonaws.com`,
  base `trading`, AZ **us-east-1f**. Su security group `default (sg-057eaa…)`
  solo admite entrada 5432 desde **miembros de ese mismo SG**.
- El motor correrá en **otra** EC2 (o en la misma, decisión pendiente del dueño).

## 3. Causa raíz del fallo (ya diagnosticada y reproducida)

Dentro del contenedor, el compose fuerza `PGHOST=postgres` (el PostgreSQL local
del compose, **sin TLS**). El `.env` de la EC2 trae `PGSSLMODE=require`
(correcto para RDS). Resultado: el cliente exige TLS a un servidor que no lo
tiene y el proceso sale en <100 ms con:

```
The server does not support SSL connections
```

Confirmarlo así (hay varias líneas de fallo, una por intento):

```bash
docker logs trading-api 2>&1 | grep -oE '"(msg|message|code)":"[^"]*"' | sort | uniq -c | sort -rn | head
```

Si el mensaje es otro, ver la tabla de la sección 5.

## 4. Pasos para resolverlo (en orden)

### 4.1 Comprobar qué versión del compose hay en la EC2

```bash
grep -c 'PGSSLMODE_DOCKER' docker-compose.yml
```

- **`0`** → versión vieja. Hacer `git pull` (este archivo llegó con la versión
  nueva, así que si lo estás leyendo en la EC2, ya está actualizada).
- **`≥1`** → versión nueva: `DATABASE_URL` implica TLS automáticamente y el
  `bridge` construye su propia imagen (desaparece el aviso `pull access denied`).

### 4.2 Escribir el `.env` de la EC2

`.env` no está versionado. Partir de `.env.example` y fijar **como mínimo**:

```bash
NODE_ENV=production
PERSIST_MODE=async

# RDS — DATABASE_URL tiene prioridad sobre PGHOST/PGUSER/... y, en Docker,
# activa TLS por sí sola. NO poner la contraseña en ningún archivo versionado.
DATABASE_URL=postgresql://trading:LA_PASSWORD@arquisoft-bbdd.cgl68cawebpp.us-east-1.rds.amazonaws.com:5432/trading
PGSSLMODE=require

# Motor de matching. Dentro de Docker mandan las *_DOCKER.
# Si el motor está en OTRA EC2: su IP PRIVADA (172.31.x.x), no la pública.
# Si está en la MISMA EC2 y fuera de Docker: http://172.17.0.1:8080 (la IP del
# host vista desde los contenedores) — NO localhost.
ENGINE_BASE_URL_DOCKER=http://IP_PRIVADA_DEL_MOTOR:8080
BRIDGE_ENGINE_WS_URL_DOCKER=ws://IP_PRIVADA_DEL_MOTOR:8080/api/trades/stream
```

`BRIDGE_TARGET_URL` / `BRIDGE_TARGET_URL_DOCKER` **no se tocan**: el bridge
empuja al propio backend (`http://api:3000/...` dentro del compose).

### 4.3 Levantar solo lo necesario (la RDS reemplaza al postgres local)

```bash
docker compose up -d --build api bridge
docker compose ps
curl -s localhost:3000/api/v1/ready
```

Esperado: `api` *healthy* y `/ready` → `"database":"up"`. `"engine":"down"` es
normal hasta que el motor esté accesible; no bloquea el arranque.

### 4.4 Si `/ready` dice `database: down`

| Mensaje en el log | Causa | Arreglo |
|---|---|---|
| `connection timeout` / `ETIMEDOUT` | El SG de la RDS no admite esta EC2 | La EC2 debe tener el SG `default`, o añadir en el SG de la RDS una regla *PostgreSQL 5432 → origen: SG de la EC2* |
| `password authentication failed` | Credenciales | Revisar `DATABASE_URL` |
| `database "trading" does not exist` | No se puso *Initial database name* al crear la RDS | Conectarse a la base `postgres` y `CREATE DATABASE trading;` |
| `no pg_hba.conf entry ... no encryption` | Falta TLS | Comprobar que `DATABASE_URL` está definida (activa `require`) |

### 4.5 Motor y red

- Motor en otra EC2: `java -jar MatchineEngine.jar` (Java 17+; en Amazon
  Linux: `sudo dnf install -y java-21-amazon-corretto`). El JAR no está en el
  repo; copiarlo con `scp`. Abrir **8080** en su SG con origen el SG de la EC2
  del backend.
- En el SG de la EC2 del backend: **3000** desde la IP del dueño (el compose
  publica `3000:3000`; `PORT_HOST` lo cambia si hiciera falta) y 22 para SSH.
- Verificación de punta a punta cuando ambos estén arriba:

```bash
curl -s -X POST localhost:3000/api/v1/orders/sell -H 'Content-Type: application/json' -d '{"userId":1,"assetId":2,"price":50.25,"quantity":10}'
curl -s -X POST localhost:3000/api/v1/orders/buy  -H 'Content-Type: application/json' -d '{"userId":2,"assetId":2,"price":51.00,"quantity":4}'
sleep 2; curl -s localhost:3000/api/v1/trades
```

Debe aparecer **un trade con `buyerUserId` y `sellerUserId` resueltos**. Si
está vacío, el `bridge` no llega al WebSocket del motor (revisar
`docker logs trading-bridge` y `BRIDGE_ENGINE_WS_URL_DOCKER`).

## 5. Experimentos de latencia (lo que se quiere medir)

Requisitos del enunciado: venta < 500 ms, compra < 300 ms, 500 ventas/min +
800 compras/min; picos de 5000 emparejamientos/min.

```bash
# régimen estable a la carga del enunciado (descartar la primera corrida: JIT)
node scripts/loadtest.js --rate 1300 --duration 60
# capacidad máxima
node scripts/loadtest.js --orders 5000 --concurrency 100
# durante la prueba: la cola debe quedarse en 0 y conflicts en 0
curl -s localhost:3000/api/v1/metrics
# después de cada corrida: ¿se perdió algún trade?
curl -s -X POST 'localhost:3000/api/v1/admin/reconcile?repair=true'
```

Variable principal del experimento: `PERSIST_MODE=async|sync` (cambiarla en
`.env` y `docker compose up -d --force-recreate api`). Secundarias:
`BATCH_SIZE`, `BATCH_INTERVAL_MS`.

Cosas que invalidan la medición:
- **El motor consume ~2 vCPU al 100 % en reposo** (espera activa en su
  bytecode; no se arregla con `application.properties`). Motor y backend en
  **instancias separadas**. Usar **t3.micro** (free tier en us-east-1; t2.micro
  ya NO lo es) en modo *unlimited*: cuesta ≈0,09 USD/h de CPU extra mientras
  el motor corre; sin *unlimited* se estrangula al 20 % y las latencias son falsas.
- No lanzar el generador de carga en la instancia del motor.
- EC2 y RDS en la **misma AZ (us-east-1f)**.
- `LOG_LEVEL=info` (con `debug` el log por request domina la latencia).
- Apagar las instancias entre sesiones: las 750 h/mes son compartidas.

## 6. Trampas del motor que hay que respetar (no "arreglar")

1. `tipo: 0` = COMPRA, `tipo: 1` = VENTA. `idActivo` de 0 a 4. El id de la
   orden vuelve en **texto plano**: `"Orden inyectada correctamente con ID: N"`.
2. El `TradeEvent` **no trae activo, ni usuarios, ni timestamp**; se reconstruye
   cruzando contra `orders` por `(engine_session_id, engine_order_id)`.
3. **El contador de ids del motor vuelve a 1 al reiniciar la JVM.** Por eso
   existen las sesiones (`engine_sessions`). El backend detecta el reinicio al
   arrancar, por sondeo y por id repetido/contador que retrocede
   (`sessionManager.observeEngineOrderId`). Los conflictos que aun así ocurran
   se cuentan en `metrics.conflicts` y van a `logs/dead-letter.ndjson`.
4. **El WebSocket no tiene reenvío**: si el bridge está caído durante un trade,
   ese trade se pierde. `POST /admin/reconcile?repair=true` repara el estado de
   las órdenes pero **no inventa trades** (el motor no informa la contraparte).
   No cambiar ese comportamiento.
5. Usar `POST /api/v1/engine/reset` y no un `curl` directo al `/api/reset` del
   motor: hay que rotar la sesión a la vez.

## 7. Qué NO hacer

- No poner la contraseña de la RDS en ningún archivo versionado.
- No editar `sql/001_schema.sql`: las migraciones aplicadas no se reejecutan;
  crear `sql/00N_*.sql` nuevos.
- No quitar `tini` ni `stop_grace_period: 30s`: el apagado ordenado vacía la
  cola write-behind; sin eso un deploy pierde lotes.
- No quitar `additionalProperties: true` de los esquemas de respuesta: Fastify
  descarta en silencio los campos no declarados.
- No abrir 5432 ni 8080 a `0.0.0.0/0`.

## 8. Checklist de cierre

- [ ] `trading-api` healthy y `/ready` con `database: up`
- [ ] Motor accesible: `/ready` con `engine: up`
- [ ] Trade de punta a punta con ambos lados resueltos
- [ ] `loadtest --rate 1300 --duration 60`: p99 venta < 500 ms, compra < 300 ms
- [ ] `reconcile` sin discrepancias tras la corrida
- [ ] Mismo experimento con `PERSIST_MODE=sync` para comparar
