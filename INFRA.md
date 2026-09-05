# INFRA — Despliegue y operación en AWS

**ARTI4109 · Reto 1 · Backend de Persistencia de Trading**

Todo lo que es *dónde corre* y *cómo se opera*, separado de lo que es *qué hace*
y *cuánto tarda*:

| Documento | Contiene |
|---|---|
| [README.md](README.md) | El proyecto: arquitectura, API, modelo de datos, Docker |
| **INFRA.md** (este) | AWS: instancias, red, arranque, balanceador, costos |
| [EXPERIMENTO.md](EXPERIMENTO.md) | La medición: protocolo, resultados, hallazgos |
| [PENDIENTES.md](PENDIENTES.md) | Traspaso de contexto y pendientes |

---

## Índice

- [Topología y direcciones](#topología-y-direcciones)
- [Security Groups](#security-groups)
- [Arranque automático tras un reinicio](#arranque-automático-tras-un-reinicio)
- [Desde dónde se ejecuta cada comando](#desde-dónde-se-ejecuta-cada-comando)
- [Prueba de carga: procedimiento de medición](#prueba-de-carga-procedimiento-de-medición)
- [Dejar el entorno limpio](#dejar-el-entorno-limpio)
- [Verificar desde el navegador que todo está arriba](#verificar-desde-el-navegador-que-todo-está-arriba)
- [Escalabilidad horizontal: balanceador de carga (NLB)](#escalabilidad-horizontal-balanceador-de-carga-nlb)

---

## Topología y direcciones

```
  tu portátil ──SSH 22 / HTTP 80──▶ EC2 persistencia (t3.micro, us-east-1b)
                                    priv 172.31.84.127 · Amazon Linux 2023 · Docker
                                    ├── trading-api     :80
                                    └── trading-bridge  (worker WS → HTTP)
                                             │ REST 8080          │ WS 8080
                                             ▼                    ▼
                                    EC2 motor (t3.micro, us-east-1b)
                                    priv 172.31.21.117 · Corretto 21 · MatchineEngine.jar

  EC2 persistencia ──TLS 5432──▶ RDS PostgreSQL 18.3 (db.t3.micro, us-east-1f)
                                 priv 172.31.70.209 · base `trading`
```

VPC `172.31.0.0/16`, subred `subnet-05aeedcc3ff209843`.

**Las IP privadas no cambian al apagar y prender; las públicas sí.** Por eso la
configuración del `.env` (`ENGINE_BASE_URL_DOCKER`, `BRIDGE_ENGINE_WS_URL_DOCKER`)
usa **siempre** las privadas y no hay que tocar nada entre reinicios. Solo
cambian los enlaces que abres tú en el navegador. Una **Elastic IP** en la EC2
de persistencia los dejaría fijos.

Y algo que conviene tener claro: **el motor nunca inicia una conexión.** Es un
servidor pasivo. El backend lo llama por REST y el bridge marca hacia él por
WebSocket. El motor no guarda ninguna dirección de este lado, así que no hay
nada que reconfigurar en su máquina.

Si alguna vez se **termina** (no se apaga) la EC2 del motor, su IP privada sí
cambia:

```bash
sed -i 's/172\.31\.21\.117/NUEVA_IP_PRIVADA/g' ~/persistencia-traiding/.env
docker compose up -d api bridge
```

---

## Security Groups

Regla de oro: **el permiso de entrada va en el SG de quien escucha**, y el
origen debe ser **otro Security Group**, nunca una IP privada. Con reglas por IP,
cualquier instancia nueva (una réplica, un clon desde AMI) queda bloqueada sin
ningún mensaje de error.

**EC2 de persistencia** — entrada:

| Tipo | Puerto | Origen | Para qué |
|---|---|---|---|
| SSH | 22 | `TU_IP/32` | Administración |
| HTTP | 80 | `TU_IP/32` | Abrir los endpoints en el navegador |
| HTTP | 80 | CIDR de la VPC | Health checks del NLB y generador de carga (solo con balanceador) |

**EC2 del motor** — entrada:

| Tipo | Puerto | Origen | Para qué |
|---|---|---|---|
| SSH | 22 | `TU_IP/32` | Administración |
| TCP | 8080 | **el SG de la persistencia** | **La regla que conecta las dos máquinas** |
| TCP | 8080 | `TU_IP/32` | Opcional: abrir `/api/estadisticas` en el navegador |

**RDS** — entrada: PostgreSQL 5432 desde **el SG de la persistencia**.

Salida: el `0.0.0.0/0` por defecto en las tres.

> Compartir un mismo SG entre las dos EC2 **no basta**: pertenecer al grupo no
> autoriza el tráfico. Hay que añadir igual la regla 8080 con origen el propio SG.

**Cómo distinguir un problema de SG de un proceso caído**, sin entrar a la consola:

| Síntoma en el navegador | Causa |
|---|---|
| Se queda cargando y expira (`ERR_CONNECTION_TIMED_OUT`) | **Security Group**: el puerto no está abierto para tu IP |
| Falla al instante (`ERR_CONNECTION_REFUSED`) | Puerto abierto, pero el proceso no está corriendo |

Un SG bloqueando *descarta* paquetes, nunca los rechaza. Lento = SG; inmediato =
proceso caído. Y recuerda que las IP domésticas son dinámicas: si tu ISP te
cambió la IP, hay que actualizar el origen de las reglas (`Mi IP` en la consola).

---

## Arranque automático tras un reinicio

**Persistencia: nada que hacer.** `docker.service` está `enabled` y los
contenedores llevan `restart: unless-stopped`, así que vuelven solos al
encender la instancia. La excepción es un `docker compose down` manual, que sí
exige un `up -d` después.

**Motor: hace falta un servicio de systemd.** Lanzarlo con `nohup` no sobrevive
al apagado. En la EC2 del motor, una sola vez:

```bash
sudo tee /etc/systemd/system/matching-engine.service >/dev/null <<'EOF'
[Unit]
Description=Motor de Emparejamiento (MatchineEngine.jar)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user
ExecStart=/usr/bin/java -Xmx512m -jar /home/ec2-user/MatchineEngine.jar
Restart=always
RestartSec=5
StandardOutput=append:/home/ec2-user/engine.log
StandardError=append:/home/ec2-user/engine.log

[Install]
WantedBy=multi-user.target
EOF

pkill -f MatchineEngine.jar          # que no choque con el proceso viejo por el 8080
sudo systemctl daemon-reload
sudo systemctl enable --now matching-engine
```

Tres detalles que importan:

- **`WorkingDirectory` no es decorativo:** Spring Boot lee el
  `application.properties` que está al lado del JAR desde el directorio de
  trabajo. Sin eso, el motor arranca con la configuración por defecto.
- **`Restart=always`** cubre también una caída de la JVM, no solo el reinicio.
- Comprueba la ruta de Java con `which java` antes (Corretto suele dejarlo en
  `/usr/bin/java`).

Operación posterior:

```bash
systemctl status matching-engine
journalctl -u matching-engine -f
sudo systemctl restart matching-engine
```

> Cada reinicio del motor **devuelve su contador de ids a 1**. El backend lo
> detecta y rota la sesión solo, así que los datos no se corrompen; pero el
> libro en memoria queda vacío.

---

## Desde dónde se ejecuta cada comando

Hay dos sitios y conviene no confundirlos:

| Comando | Dónde se ejecuta | Por qué |
|---|---|---|
| `docker compose ...` | **Dentro de la EC2 de persistencia** (`ssh ec2-user@IP_PERSISTENCIA`, luego `cd ~/persistencia-traiding`) | Es donde vive el stack |
| `node scripts/loadtest.js` | **Dentro del contenedor**, vía `docker compose exec api` | El host no tiene Node ni `node_modules`; la imagen sí, con todo instalado |
| `curl` de consulta | Desde donde sea: tu portátil, Postman o el navegador | Basta con cambiar `localhost` por la IP pública |

El generador se lanza contra `http://127.0.0.1:80`, es decir el propio
contenedor. **No usar la IP pública para medir**: se estaría midiendo también la
latencia de internet, y los p99 dejarían de significar lo que pide el enunciado.

## Prueba de carga: procedimiento de medición

Todo desde la EC2 de persistencia, en `~/persistencia-traiding`:

```bash
# 1. Calentamiento. NO se reporta: solo sirve para que el JIT de la JVM y de
#    Node dejen de contaminar los percentiles. También escribe en la base.
docker compose exec api node scripts/loadtest.js --url http://127.0.0.1:80 --rate 1300 --duration 20

# 2. Sesión virgen, para que los conteos de /sessions sean los de la medición
curl -X POST localhost/api/v1/engine/reset

# 3. La medición: carga normal del enunciado (500 ventas + 800 compras por minuto)
docker compose exec api node scripts/loadtest.js --url http://127.0.0.1:80 --rate 1300 --duration 60

# 4. Comprobaciones posteriores
curl localhost/api/v1/admin/reconcile   # backend y motor deben coincidir
curl localhost/api/v1/sessions          # órdenes y trades que dejó la corrida
curl localhost/api/v1/metrics           # cola de escritura, lotes fallidos, dead letter
```

El script compara solo contra los SLO y marca `OK` o `FALLA` por lado. Los dos
modos de carga:

| Invocación | Para qué |
|---|---|
| `--rate 1300 --duration 60` | Carga sostenida del enunciado, durante N segundos |
| `--orders 5000 --concurrency 100` | Saturación: 10× la carga, lo más rápido que aguante |

Para la comparación `async` vs `sync` se cambia el modo y se repite el
procedimiento completo (calentamiento incluido):

```bash
sed -i 's/^PERSIST_MODE=async/PERSIST_MODE=sync/' .env
docker compose up -d api
```

## Dejar el entorno limpio

Antes de una medición formal, para que la base y el motor arranquen de cero.
**Borra datos de forma irreversible.**

```bash
cd ~/persistencia-traiding

# 1. Vaciar el libro en memoria del motor
curl -s -X POST http://IP_PRIVADA_MOTOR:8080/api/reset

# 2. Parar los que escriben: el backend guarda el id de sesión en memoria y
#    fallaría al insertar contra una fila que ya no existe
docker compose stop api bridge

# 3. Vaciar las tablas transaccionales (`assets` se conserva: es catálogo)
DBURL=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
docker exec trading-postgres psql "${DBURL}?sslmode=require" -v ON_ERROR_STOP=1 \
  -c "TRUNCATE TABLE trades, orders, positions, engine_sessions, users RESTART IDENTITY CASCADE;"

# 4. Levantar el backend: aplica migraciones y abre una sesión nueva solo
docker compose up -d api

# 5. Volver a sembrar los usuarios con saldo
docker compose exec api node scripts/seed.js

# 6. Y por último el worker
docker compose up -d bridge

# 7. Verificar: overall ok, conteos en 0, una sola sesión
curl localhost/api/v1/status
```

El orden importa. Truncar con el backend vivo deja su sesión en memoria
apuntando a una fila borrada, y el `bridge` se levanta al final para no empujar
trades contra un backend a medio arrancar.

El paso 3 usa el contenedor `trading-postgres` **solo como cliente `psql`** —
se conecta a la RDS, no a él mismo — porque el host no trae el cliente
instalado. Si ese contenedor está parado, `docker compose up -d postgres`
antes, o usar cualquier `psql` que se tenga a mano contra `DATABASE_URL`.

> **No borrar filas a mano de forma selectiva.** Las posiciones y los saldos son
> acumulativos: un `DELETE` de órdenes y trades no los revierte y deja
> portafolios que no corresponden a nada. O se vacía todo como aquí, o se filtra
> por `engine_session_id`, que es para lo que existen las sesiones.

## Verificar desde el navegador que todo está arriba

Basta con abrir estas URLs con la IP pública de cada instancia. Antes,
comprobar que el Security Group de cada una permite entrada TCP en su puerto
(80 para la persistencia, 8080 para el motor) desde la IP de quien mira.

**Servidor de persistencia** (puerto 80: no hace falta escribirlo en la URL):

| URL | Qué dice |
|---|---|
| `http://IP_PERSISTENCIA/api/v1/health` | Solo que el proceso Node está vivo: `{"status":"ok","uptime":…}`. No toca ni la base ni el motor. |
| `http://IP_PERSISTENCIA/api/v1/ready` | **El que importa.** Consulta la RDS y el motor y devuelve `checks.database` y `checks.engine` en `up` o `down`. Si la base no responde, el código HTTP es `503`. |
| `http://IP_PERSISTENCIA/api/v1/status` | Vista completa para un operador: host real de la base, TLS, migraciones aplicadas, latencia del motor, sesión activa y cola de escritura. `overall` vale `ok`, `degraded` o `down`. Siempre `200`. |
| `http://IP_PERSISTENCIA/docs` | Swagger UI, para probar cualquier endpoint desde ahí. |

**Servidor del motor** (puerto 8080):

| URL | Qué dice |
|---|---|
| `http://IP_MOTOR:8080/api/estadisticas` | Estadísticas en vivo. Es el endpoint que el backend usa para saber si el motor responde. |
| `http://IP_MOTOR:8080/api/libro` | Libro de órdenes actual. |

Si cualquiera de las dos responde JSON, el motor está arriba.

**Comprobación mínima:** abrir `/api/v1/ready` en el servidor de persistencia.
Con `database: up` y `engine: up`, las dos máquinas y la RDS están saludables y
además se ven entre sí, que es lo que importa. Si `engine` sale `down` pero al
motor se llega directo por su IP pública, el problema es de red entre las dos
instancias: normalmente el Security Group del motor no admite tráfico desde la
instancia de persistencia, o `ENGINE_BASE_URL` apunta a la IP equivocada.

---

## Escalabilidad horizontal: balanceador de carga (NLB)

Extensión del experimento. El montaje de las secciones 2–6 de [EXPERIMENTO.md](EXPERIMENTO.md) mide **una sola**
instancia de persistencia; esta sección replica el backend detrás de un
**Network Load Balancer** para separar dos preguntas que el reto mezcla:
¿mejora la latencia al escalar el gateway, y hasta dónde se puede escalar
antes de chocar contra el componente con estado?

### Por qué NLB y no ALB

| | NLB (capa 4) | ALB (capa 7) |
|---|---|---|
| Latencia añadida | Del orden de microsegundos | Proxy HTTP completo: milisegundos |
| IP del cliente | La preserva | La sustituye (llega en `X-Forwarded-For`) |
| Costo por tráfico TCP | Menor | Mayor |

Cuando la variable que se mide **es** la latencia, un proxy HTTP en medio
contamina el resultado. No hay routing por path ni terminación TLS que
justifique el ALB aquí.

### Las tres configuraciones (no una)

Medir solo «antes y después» no permite concluir nada: si la latencia baja, no
se sabe cuánto fue por escalar y cuánto por el camino de red nuevo. Se miden
tres puntos con la misma infraestructura:

| # | Montaje | Qué aísla |
|---|---|---|
| **A** | generador → 1 EC2 **directo** | Línea base (los resultados de EXPERIMENTO.md §6) |
| **B** | generador → NLB → **1** target | El peaje del balanceador: **B − A** |
| **C** | generador → NLB → **2** targets | La ganancia de escalar: **C − B** |

Para pasar de C a B basta con desregistrar una instancia del target group; no
hay que destruir nada.

| Config | Venta p99 (< 500 ms) | Compra p99 (< 300 ms) | Throughput | Fallidas |
|---|---|---|---|---|
| A — directo | | | | |
| B — NLB, 1 target | | | | |
| C — NLB, 2 targets | | | | |

### Topología

```
generador (t3.micro) ──▶ NLB interno :80 ──┬──▶ persistencia A  (con bridge)
                                            └──▶ persistencia B  (sin bridge)
                                                        │ REST + WS 8080
                                                        ▼
                                                  MOTOR (uno solo) 
                                                        │
                                              ambas ────┴──▶ RDS (TLS)
```

**Un solo motor, y no es negociable.** El libro de órdenes vive en la memoria
de esa JVM: dos motores serían dos libros independientes, y una compra inyectada
en uno jamás se emparejaría con una venta inyectada en el otro. Es el mismo
argumento por el que se descartó Lambda (EXPERIMENTO.md §2). El motor es el componente con
estado; el backend es la parte que escala.

**Todo en una sola AZ.** Repartir entre zonas añade décimas de milisegundo a
cada petición —ruido justo sobre la variable medida— y factura transferencia
entre AZ en los dos sentidos. La alta disponibilidad multi-AZ es otro
experimento, no este.

### El bridge va en UNA sola instancia

El motor publica los trades por WebSocket en **broadcast**: dos bridges
suscritos reciben cada trade dos veces. No corrompe datos —el índice único
`(engine_session_id, buy_engine_order_id, sell_engine_order_id)` con
`ON CONFLICT DO NOTHING … RETURNING` descarta el duplicado, y solo el trade
realmente insertado mueve órdenes, posiciones y saldos— pero duplica el trabajo
y descuadra las métricas.

Por eso las réplicas arrancan con `BRIDGE_REPLICAS=0` en su `.env`. El
`docker-compose.yml` lo resuelve con `deploy.replicas`, así que el valor por
defecto sigue siendo 1 y el stack de siempre no cambia.

El precio es explícito: el bridge queda como **punto único de fallo**. Si cae la
instancia que lo hospeda, el balanceador sigue aceptando órdenes pero dejan de
persistirse trades. Es exactamente el hueco que tapa MSK en el diagrama de
despliegue (EXPERIMENTO.md §9), ahora visible en la topología.

### Dos backends contra un motor: qué aguanta el diseño y qué no

Verificado leyendo `src/services/sessionManager.js`:

- **Comparten sesión sin cambios.** Al arrancar, la réplica encuentra la sesión
  abierta en la RDS, comprueba que el motor conserva su libro
  (`ordenesProcesadasTotales >= órdenes registradas`) y la **reanuda** en vez de
  abrir una nueva. Ambos backends escriben bajo el mismo `engine_session_id`,
  así que cualquier trade se resuelve contra órdenes de cualquiera de los dos.
- **No hay rotaciones espurias.** El contador de ids del motor es global y
  monótono mientras viva la JVM, así que la secuencia de ids que ve cada
  instancia también sube. `observeEngineOrderId` no se dispara.
- **Límite conocido: reiniciar el motor con los dos backends arriba produce
  split-brain.** Ambos detectan el reinicio, ambos llaman a `rotate()`, y cada
  uno cierra la sesión del otro para abrir la suya: quedan dos sesiones con las
  órdenes repartidas. Mitigación operativa: tras cualquier `engine/reset` o
  reinicio del motor, **reiniciar los dos backends** (`docker compose restart api`)
  para que converjan a la misma sesión.
- **La cola write-behind y el `logs/dead-letter.ndjson` son locales de cada
  instancia.** Para el informe hay que sumar los `/metrics` de ambas, no leer
  una sola.

### Montaje con CloudFormation

La plantilla [`infra/nlb-experimento.yaml`](infra/nlb-experimento.yaml) crea el
NLB, el target group, el listener, la réplica del backend y la instancia
generadora. La ventaja no es escribir menos: es que **se borra entera con un
comando**, que es la mejor defensa contra el riesgo real de este experimento —
olvidarse un balanceador encendido.

#### Paso 0 — credenciales y permisos

Desde tu equipo, con la CLI de AWS instalada:

```bash
aws configure       # Access Key, Secret Key, región us-east-1, salida json
aws sts get-caller-identity      # comprobar que responde con tu cuenta
```

El usuario IAM necesita, como mínimo, poder actuar sobre
`cloudformation:*`, `ec2:*` y `elasticloadbalancing:*`. Si usas un usuario
personal con `AdministratorAccess` en una cuenta de laboratorio, ya está.

> **Las claves de acceso no se pegan en un chat ni se suben al repo.** Viven en
> `~/.aws/credentials` de tu máquina. El rol de la EC2
> (`EC2-CloudWatchRole`) **no** tiene estos permisos, así que el despliegue se
> lanza desde tu equipo, no desde la instancia.

#### Paso 1 — arreglar los Security Groups

Antes que nada, y es lo que rompe el montaje si se salta. Las reglas del motor
(8080) y de la RDS (5432) deben tener como origen **el SG de la persistencia**,
no la IP privada `172.31.84.127/32`: la réplica nacerá con otra IP y quedaría
bloqueada sin ningún error visible.

`EC2 → Security Groups → el del motor → Editar reglas de entrada`. En Origen,
borra la IP y escribe `sg-` para que te ofrezca el SG de la persistencia. Repite
en el SG de la RDS.

La plantilla añade sola el puerto 80 desde el CIDR de la VPC, que es lo que
necesitan los health checks del NLB.

#### Paso 2 — crear la AMI

CloudFormation no puede fotografiar una instancia que ya existe, así que este
paso es manual. **Un snapshot de EBS por sí solo no se puede lanzar**: hace
falta la AMI, que incluye el snapshot más la plantilla de arranque.

`EC2 → Instancias → la de persistencia → Acciones → Imagen y plantillas →
Crear imagen`. Nombre `trading-persistencia-v1`, el resto por defecto. En
`EC2 → AMIs`, esperar a que pase de *pending* a **available** (5–10 min) y
copiar el id `ami-0abc...`.

#### Paso 3 — reunir los parámetros

| Parámetro | Valor / dónde encontrarlo |
|---|---|
| `VpcId` | `vpc-04ffa8ac9023d3654` |
| `SubnetId` | `subnet-05aeedcc3ff209843` |
| `BackendSecurityGroupId` | `EC2 → la instancia → Seguridad` (`launch-wizard-1`) |
| `BackendAmiId` | El del paso 2 |
| `ExistingBackendInstanceId` | `i-066240bbc580e697d` |
| `KeyName` | Nombre del par de llaves, **sin** el `.pem` |

#### Paso 4 — desplegar

```bash
aws cloudformation deploy \
  --stack-name trading-nlb \
  --template-file infra/nlb-experimento.yaml \
  --parameter-overrides \
      VpcId=vpc-04ffa8ac9023d3654 \
      SubnetId=subnet-05aeedcc3ff209843 \
      BackendSecurityGroupId=sg-XXXX \
      BackendAmiId=ami-XXXX \
      ExistingBackendInstanceId=i-066240bbc580e697d \
      KeyName=tu-llave
```

Tarda unos 3 minutos. Alternativa sin CLI:
`CloudFormation → Crear stack → Cargar un archivo de plantilla`, se sube el YAML
y los parámetros se piden en un formulario.

#### Paso 5 — sacar el DNS del balanceador

```bash
aws cloudformation describe-stacks --stack-name trading-nlb \
  --query 'Stacks[0].Outputs' --output table
```

#### Paso 6 — esperar a que los targets estén sanos

`EC2 → Target Groups → trading-tg-80 → Targets`: las dos instancias deben decir
**healthy**. Si una sale *unhealthy*, casi siempre es el puerto 80 en el SG.

### Medir

Desde el generador, que **no** debe ser ninguna de las dos instancias
balanceadas: competiría por la CPU del `t3.micro` que está sirviendo tráfico y
el NLB podría enrutar de vuelta a esa misma máquina.

```bash
# La AMI ya trae la imagen: no hay que instalar Node ni levantar el stack
docker run --rm trading-persistence:latest \
  node scripts/loadtest.js --url http://<dns-del-nlb> --rate 1300 --duration 60
```

Comprobar que el reparto ocurre de verdad, consultando cada instancia por su IP
privada durante la corrida:

```bash
curl http://<ip-privada-A>/api/v1/metrics
curl http://<ip-privada-B>/api/v1/metrics
```

### Desmontaje

```bash
aws cloudformation delete-stack --stack-name trading-nlb
```

Borra NLB, listener, target group, réplica, generador y la regla de SG añadida.
Queda **una cosa fuera del stack**, la que se olvida siempre: la **AMI y su
snapshot**, que se facturan por GB-mes. `EC2 → AMIs → Anular registro`, y
después `EC2 → Snapshots → Eliminar`.

### Costo

Cifras de referencia de `us-east-1`, sujetas a cambio: conviene confirmarlas en
la calculadora de AWS. Para una corrida de menos de una hora:

| Concepto | ~1 hora |
|---|---|
| NLB (hora + NLCU) | ~$0.03 |
| 2 × `t3.micro` (réplica y generador) | ~$0.02 |
| Transferencia (misma AZ, NLB interno) | $0 |
| **Total** | **< $0.10** |

El costo de medir es despreciable; el costo de olvidar no. Un NLB encendido son
del orden de $16/mes y cada IPv4 pública sin usar ~$3.6/mes. De ahí que el NLB
sea **interno** (no asigna IPv4 públicas) y que todo viva en un stack que se
borra de un tirón.
