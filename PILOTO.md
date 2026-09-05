# PILOTO — Guía paso a paso para correr el experimento desde un Mac

> Guía operativa para ejecutar a mano el piloto del experimento de escalabilidad
> (balanceador NLB con 2 targets contra 1) y guardar la evidencia. Es
> autocontenida: no hace falta haber leído los otros documentos. El detalle de
> la infraestructura está en [INFRA.md](INFRA.md); el protocolo de medición
> base, en [EXPERIMENTO.md](EXPERIMENTO.md).

## 0. Qué hay montado ahora mismo (cuenta AWS 660360494821, región us-east-1)

| Pieza | Identificador | IP privada (fija) |
|---|---|---|
| EC2 persistencia original | `i-066240bbc580e697d` | 172.31.84.127 |
| EC2 réplica de persistencia | `i-0355dc1e06f770749` | 172.31.86.199 |
| EC2 generador de carga | `i-0517df006919e40f1` | 172.31.88.252 |
| EC2 motor de emparejamiento | `i-03d62904b8f2f5b48` | 172.31.21.117 |
| Balanceador NLB (DNS, fijo mientras exista el stack) | `http://trading-nlb-3873526197343ac2.elb.us-east-1.amazonaws.com` | |
| Target group | `arn:aws:elasticloadbalancing:us-east-1:660360494821:targetgroup/trading-tg-80/d7601f5555d27d04` | |
| Stack de CloudFormation | `trading-nlb` | |
| RDS PostgreSQL 18.3 | `arquisoft-bbdd` (`db.t4g.micro`, us-east-1f) | 172.31.70.209 |
| Par de llaves SSH | `Arquisoft` (archivo `Arquisoft.pem`) | |

**El NLB es interno** (`Scheme: internal`). Su DNS solo se resuelve y se
alcanza **desde dentro de la VPC**: desde el Mac no responde, y eso no es una
avería. Es el motivo de que la carga se lance desde la EC2 generadora, y es
interno a propósito, porque un NLB *internet-facing* asigna una IPv4 pública
por AZ y cada una se factura por hora.

`delete-stack` (paso 11) se lleva el NLB, el listener, el target group, la
réplica y el generador. **No** se lleva la EC2 original, ni el motor, ni la
RDS, ni la AMI con su snapshot.

### IPs públicas vigentes

Comprobadas contra AWS el **2026-09-05**, con las cuatro instancias en
`running` y sin apagarse desde entonces:

| Instancia | IP pública | Encendida desde (UTC) |
|---|---|---|
| original | 34.226.139.255 | 13:01 |
| réplica | 44.201.252.165 | 15:51 |
| generador | 54.159.150.22 | 15:51 |
| motor | 54.227.51.136 | 13:01 |

**Las IPs públicas cambian cada vez que una instancia se apaga y se enciende.**
Las privadas no. Mientras nadie apague nada las de arriba sirven; tras un
apagón hay que consultarlas con el comando del paso 2.

Todo este bloque está verificado contra la cuenta real el 2026-09-05
(`describe-instances`, `describe-load-balancers`, `describe-target-groups`,
`describe-target-health`, `describe-db-instances`, `describe-stacks`): los
cuatro instance-id, las IPs privadas y públicas, el DNS del NLB y su
`Scheme: internal`, el ARN del target group con su health check
(`/api/v1/ready`, cada 10 s, umbral 2), sus **dos targets en `healthy`**, y el
stack `trading-nlb` en `CREATE_COMPLETE`.

## 1. Preparar el Mac (una sola vez)

### 1.1 Instalar la CLI de AWS

```bash
brew install awscli
aws --version
```

Sin Homebrew: descargar el instalador `.pkg` desde
<https://aws.amazon.com/cli/> y seguir el asistente.

### 1.2 Configurar el perfil `arquisoft` sin tocar otros perfiles

La CLI guarda varias cuentas en "perfiles". Si el Mac ya tiene configurada la
CLI para la empresa (perfil `default`), **no se toca**: se crea un perfil
aparte con nombre y se activa solo en la terminal donde se trabaja.

Primero hacen falta unas claves de acceso de la cuenta de Arquisoft:
consola de AWS → IAM → Users → el usuario → *Security credentials* →
*Create access key* → *Command Line Interface (CLI)*. Se muestran una sola vez.

```bash
aws configure --profile arquisoft
#   AWS Access Key ID:      (la clave creada)
#   AWS Secret Access Key:  (el secreto)
#   Default region name:    us-east-1
#   Default output format:  json
```

Comprobar que responde con la cuenta correcta (660360494821):

```bash
aws sts get-caller-identity --profile arquisoft
```

En cada terminal nueva donde se vaya a trabajar con este proyecto, activar el
perfil una vez y ya no hace falta escribir `--profile` en cada comando:

```bash
export AWS_PROFILE=arquisoft
```

Al cerrar la terminal, la CLI vuelve al perfil de la empresa. Las claves nunca
se pegan en un chat, ni se suben al repositorio, ni se comparten por mensaje.

### 1.3 La llave SSH

Copiar `Arquisoft.pem` a una carpeta del Mac (por ejemplo `~/.ssh/`) y
restringir sus permisos, si no `ssh` se niega a usarla:

```bash
chmod 400 ~/.ssh/Arquisoft.pem
```

### 1.4 Clonar el repositorio — solo para guardar la evidencia (paso 9)

El piloto **no se corre desde el Mac**. Todo pasa en la nube: la carga la lanza
la EC2 generadora, que ya trae el repo y la imagen Docker dentro de la AMI. Los
pasos 2 a 8 no tocan este clon; el Mac solo hace de terminal (`ssh`) y de mando
a distancia de AWS (`aws`).

Entonces, ¿para qué clonar? Por una sola razón: **el generador y la réplica son
desechables**. Viven dentro del stack, y `delete-stack` borra sus discos con
todo lo que hayan producido. La evidencia tiene que aterrizar en una máquina
que sobreviva y desde la que se pueda hacer `git push`. El Mac es esa máquina.

Se puede dejar para el paso 9: no es requisito para empezar a medir.

```bash
git clone <url-del-repo> ~/Perssitencia-trading
cd ~/Perssitencia-trading
```

Alternativas, si no quieres clonar en el Mac: bajar los resultados con `scp` a
cualquier carpeta y subirlos a mano, o copiarlos a la EC2 de persistencia
**original**, que no está en el stack y sobrevive al `delete-stack` (el repo
vive allí en `~/persistencia-traiding`) — aunque esa máquina no tiene
credenciales de `git push`. Lo que no vale: dejar la única copia en el
generador o en la réplica.

## 2. Encender y comprobar (desde el Mac)

A 2026-09-05 las cuatro instancias **ya están encendidas** y los dos targets ya
salen `healthy`. Si nadie ha apagado nada desde entonces, este paso se salta
entero y se va directo al 3; los comandos de abajo son para volver a empezar
tras un apagón.

```bash
export AWS_PROFILE=arquisoft

# Encender las cuatro instancias (si ya están encendidas no pasa nada)
aws ec2 start-instances --instance-ids i-03d62904b8f2f5b48 i-066240bbc580e697d i-0355dc1e06f770749 i-0517df006919e40f1

# Esperar ~1 minuto y sacar las IPs públicas de hoy
aws ec2 describe-instances \
  --instance-ids i-03d62904b8f2f5b48 i-066240bbc580e697d i-0355dc1e06f770749 i-0517df006919e40f1 \
  --query 'Reservations[].Instances[].[Tags[?Key==`Name`]|[0].Value,State.Name,PublicIpAddress,PrivateIpAddress]' --output table

# Las dos instancias detrás del balanceador deben decir "healthy"
aws elbv2 describe-target-health \
  --target-group-arn arn:aws:elasticloadbalancing:us-east-1:660360494821:targetgroup/trading-tg-80/d7601f5555d27d04 \
  --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State]' --output table

# Monitoreo detallado de CloudWatch (puntos cada 1 min en vez de 5). Se apaga al final.
aws ec2 monitor-instances --instance-ids i-03d62904b8f2f5b48 i-066240bbc580e697d i-0355dc1e06f770749
```

Si un target sale `unhealthy` tras encender, esperar un minuto más. El
balanceador consulta `GET /api/v1/ready` **cada 10 segundos y necesita dos
respuestas buenas seguidas** para marcarlo `healthy`: en el mejor de los casos
tarda ~20 s desde que la API levanta, y `/ready` no devuelve 200 hasta que la
RDS y el motor contestan.

## 3. Entrar al generador y comprobar la sesión del motor

Se usa la IP pública **del generador** que salió en el paso 2.

```bash
ssh -i ~/.ssh/Arquisoft.pem ec2-user@<IP-PUBLICA-GENERADOR>

curl -s http://172.31.84.127/api/v1/status | grep -o '"session":{"id":"[^"]*"'
curl -s http://172.31.86.199/api/v1/status | grep -o '"session":{"id":"[^"]*"'
```

**Los dos ids deben ser iguales.** Si no lo son, los trades de una instancia no
resolverían las órdenes de la otra y la medición no vale. Arreglo: mandar una
orden por cualquiera de las dos y reiniciar la API de la otra:

```bash
curl -s -X POST http://172.31.86.199/api/v1/orders/sell -H 'Content-Type: application/json' \
  -d '{"userId":1,"assetId":2,"price":999,"quantity":1}'
# en otra terminal del Mac, contra la EC2 original:
ssh -i ~/.ssh/Arquisoft.pem ec2-user@<IP-PUBLICA-ORIGINAL> 'cd persistencia-traiding && docker compose restart api'
```

Esperar 30 s y volver a comparar.

> **Estado real comprobado el 2026-09-05 — hay que arreglarlo antes de medir.**
> Los dos ids **no coinciden** ahora mismo:
>
> | Instancia | `session.id` |
> |---|---|
> | original | `01a07273-5682-71be-879a-045b9b077ba1` |
> | réplica | `01a07273-5475-7e4c-ae91-03ad3984486d` |
>
> Y el motor está en frío, que es justo la causa —
> `curl -s http://172.31.21.117:8080/api/estadisticas` devuelve
> `{"ordenesEnCompra":0,"ordenesEnVenta":0,"tradesEmparejados":0,"ultimaOrdenRecibida":0,"ordenesProcesadasTotales":0}`.
> Hoy el piloto **no se puede medir tal cual está**: primero el arreglo de
> arriba, y no seguir hasta que los dos ids coincidan.

Por qué funciona: al arrancar, un backend reanuda la sesión abierta en la RDS
solo si comprueba que el motor conserva su libro. Con el motor recién encendido
(cero órdenes procesadas) no puede distinguirlo de un reinicio y abre una sesión
nueva, cerrando la del otro. La orden de arriba hace que deje de ser cero; el
reinicio hace que el otro la reanude. La lógica está en
[`src/services/sessionManager.js`](src/services/sessionManager.js).

## 3 bis. Los dos formatos JSON

Hay **dos contratos JSON distintos**, en dos capas distintas. Se confunden a
menudo porque los dos describen "una orden".

**1) Cliente → API de persistencia** (puerto 80, `/api/v1/orders/…`). Campos en
inglés; el lado (compra o venta) va en la **ruta**, no en el cuerpo. Es el
formato del `curl` del paso 3 y el que usa el `loadtest`.

```http
POST /api/v1/orders/buy      (o /api/v1/orders/sell)
{"userId":1,"assetId":2,"price":999,"quantity":1}
```

| Campo | Regla |
|---|---|
| `userId` | entero ≥ 0 |
| `assetId` | entero de 0 a 4 (el motor solo admite cinco activos) |
| `price` | decimal > 0, máximo 2 decimales |
| `quantity` | entero ≥ 1 |
| `clientOrderId` | opcional; reenviar con el mismo id devuelve la orden original (200) en vez de duplicarla |

También existe `POST /api/v1/orders` con `"side":"BUY"|"SELL"` en el cuerpo. El
esquema es estricto (`additionalProperties: false`): mandarle `idUsuario` o
`tipo` a **esta** API devuelve `400 ValidationError`. Comprobado el 2026-09-05
contra la instancia real.

**2) Persistencia → MatchineEngine** (puerto 8080, `/api/ordenes`). Campos en
español, con `tipo`. **En el piloto nadie escribe este JSON a mano**: lo
construye el backend. Aparece aquí solo para reconocerlo.

```http
POST /api/ordenes
{"idUsuario":42,"idActivo":2,"tipo":0,"precio":105.5,"cantidad":500}
```

`tipo: 0` = COMPRA, `tipo: 1` = VENTA. El motor responde el id de la orden en
**texto plano** (`… ID: 17`), no en JSON.

La traducción, tal como la hace
[`src/services/orderService.js`](src/services/orderService.js):

| API pública | → | Motor |
|---|---|---|
| `userId` | → | `idUsuario` |
| `assetId` | → | `idActivo` |
| ruta `/buy` \| `/sell` | → | `tipo` (0 \| 1) |
| `price` (decimal) | → | `precio` (decimal, **no** centavos) |
| `quantity` | → | `cantidad` |

Los centavos (`BIGINT`) son solo la representación interna de la base de datos:
ni la API pública ni el motor los ven.

**Regla práctica:** si la URL lleva `/api/v1/` es formato inglés; si lleva
`:8080/api/` es formato español.

Esperar 30 segundos y volver a comparar los ids.

## 4. Preparar la carpeta de la corrida y el muestreo (en el generador)

Todo lo que produce una corrida va a una carpeta con fecha. Un bucle en
segundo plano guarda cada 5 segundos las métricas de los dos backends (cola de
escritura, conflictos, conteos) y las estadísticas del motor.

```bash
RUN=~/results/piloto-$(date +%F-%H%M); mkdir -p $RUN; cd $RUN
NLB=http://trading-nlb-3873526197343ac2.elb.us-east-1.amazonaws.com

( while true; do
    T=$(date -u +%FT%TZ)
    echo "{\"t\":\"$T\",\"node\":\"original\",\"m\":$(curl -s http://172.31.84.127/api/v1/metrics)}"
    echo "{\"t\":\"$T\",\"node\":\"replica\",\"m\":$(curl -s http://172.31.86.199/api/v1/metrics)}"
    echo "{\"t\":\"$T\",\"node\":\"motor\",\"m\":$(curl -s http://172.31.21.117:8080/api/estadisticas)}"
    sleep 5
  done ) > metrics.ndjson &
echo $! > muestreo.pid
```

Las métricas de `/api/v1/metrics` son **locales de cada instancia**: la cola
write-behind, los contadores y el dead-letter no se comparten. Para el informe
hay que **sumar las dos**, no leer una sola; por eso el muestreo las consulta
por su IP privada y nunca a través del NLB.

Contadores útiles: `enqueued` (items encolados — el proxy del trabajo que le
tocó a esa instancia), `queueDepth` y `maxQueueDepth`, `saturated`
(backpressure activo), `dropped` y `deadLettered` (lo que se perdió) y
`conflicts` (reenvíos ignorados).

Los pasos 4, 6 y 7 deben correr en **la misma terminal**, o `$RUN` y `$NLB` no
estarán definidos.

## 5. CPU de cada máquina (tres terminales más)

Una terminal por instancia, con la misma llave y la IP pública de cada una.
Se lanza **justo antes** de la carga; 300 segundos cubren las tres corridas.

```bash
ssh -i ~/.ssh/Arquisoft.pem ec2-user@<IP-PUBLICA-ORIGINAL>
ssh -i ~/.ssh/Arquisoft.pem ec2-user@<IP-PUBLICA-REPLICA>
ssh -i ~/.ssh/Arquisoft.pem ec2-user@<IP-PUBLICA-MOTOR>

vmstat -t 1 300 > ~/cpu-$(hostname)-$(date +%H%M).txt
```

Columnas que importan: `us` + `sy` es la CPU usada, `id` la ociosa, `st` es la
que el hipervisor le quitó a la instancia. **Si `st` sube de 0, la instancia se
estaba frenando y esa corrida no vale.**

## 6. Las corridas (en el generador, en la carpeta del paso 4)

```bash
# Calentamiento. NO se reporta: solo para que el JIT del motor y de Node no contaminen.
docker run --rm trading-persistence:latest node scripts/loadtest.js --url $NLB --rate 1300 --duration 60 > 0-calentamiento.txt

# Carga normal del enunciado: 500 ventas + 800 compras por minuto
docker run --rm trading-persistence:latest node scripts/loadtest.js --url $NLB --rate 1300 --duration 60 | tee 1-normal-1300.txt

# Pico 5x
docker run --rm trading-persistence:latest node scripts/loadtest.js --url $NLB --rate 6500 --duration 60 | tee 2-pico-6500.txt

# Relajación: sin carga. Se observa cuánto tarda la cola en volver a 0.
sleep 90
```

Para ver en vivo el reparto entre las dos instancias durante el pico, en otra
terminal del generador:

```bash
watch -n 2 'for ip in 172.31.84.127 172.31.86.199; do
              echo -n "$ip  "
              curl -s http://$ip/api/v1/metrics |
                grep -o "\"enqueued\":[0-9]*\|\"queueDepth\":[0-9]*\|\"saturated\":[a-z]*" |
                tr "\n" "  "
              echo
            done'
```

Si el balanceador está repartiendo, `enqueued` sube en **las dos**.

`--rate` es en órdenes **por minuto**, y el `loadtest` reparte solo la mezcla
800 compras / 500 ventas del enunciado (los mismos 1300). El informe de cada
corrida marca `OK` o `FALLA` contra los límites del reto: p99 < 300 ms en
compra y < 500 ms en venta.

## 7. Cerrar la corrida (en el generador)

```bash
kill $(cat muestreo.pid)
curl -s -X POST 'http://172.31.84.127/api/v1/admin/reconcile?repair=true' > reconcile.json
curl -s http://172.31.84.127/api/v1/status > status-final-original.json
curl -s http://172.31.86.199/api/v1/status > status-final-replica.json

cat > NOTAS.md <<EOF
Corrida: $RUN
Variante: A (2 targets)
Motor encendido desde: (hora)
Quién ejecutó:
Observaciones (errores, cosas raras, lo que se vio en el watch):
EOF
ls -la
```

`reconcile.json` debe decir que no hay discrepancias. Si las hay, anotarlo en
`NOTAS.md`: es un hallazgo, no un fallo de la prueba.

## 8. Variante B: un solo target

No hay que desmontar nada. Se saca la réplica del balanceador, se repite desde
el paso 4 con una carpeta nueva (poner `Variante: B (1 target)` en las notas),
y al terminar se vuelve a meter.

```bash
export AWS_PROFILE=arquisoft
TG=arn:aws:elasticloadbalancing:us-east-1:660360494821:targetgroup/trading-tg-80/d7601f5555d27d04

aws elbv2 deregister-targets --target-group-arn $TG --targets Id=i-0355dc1e06f770749
# ... corridas de B ...
aws elbv2 register-targets   --target-group-arn $TG --targets Id=i-0355dc1e06f770749
```

La réplica sale del balanceador pero **sigue encendida y con su API viva**. No
apagarla: al volver a encenderla podría abrir una sesión nueva y habría que
rehacer el paso 3.

Esperar a que el target vuelva a `healthy` (paso 2) antes de otra corrida de A.

## 9. Guardar los resultados en el repositorio (desde el Mac)

**El generador y la réplica son desechables**: borrar el stack borra sus discos
con todo lo que haya dentro. Los resultados se bajan al Mac y se versionan
**antes** de desmontar nada.

```bash
cd ~/Perssitencia-trading
mkdir -p results

scp -i ~/.ssh/Arquisoft.pem -r ec2-user@<IP-PUBLICA-GENERADOR>:results/piloto-* results/
scp -i ~/.ssh/Arquisoft.pem 'ec2-user@<IP-PUBLICA-ORIGINAL>:cpu-*.txt' results/piloto-<fecha>/
scp -i ~/.ssh/Arquisoft.pem 'ec2-user@<IP-PUBLICA-REPLICA>:cpu-*.txt'  results/piloto-<fecha>/
scp -i ~/.ssh/Arquisoft.pem 'ec2-user@<IP-PUBLICA-MOTOR>:cpu-*.txt'    results/piloto-<fecha>/
```

La evidencia que guarda AWS, exportada a texto para no depender de la
retención de CloudWatch (los puntos de 1 minuto solo duran 15 días):

```bash
export AWS_PROFILE=arquisoft
for id in i-066240bbc580e697d i-0355dc1e06f770749 i-03d62904b8f2f5b48; do
  aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization \
    --dimensions Name=InstanceId,Value=$id --period 60 --statistics Average Maximum \
    --start-time "$(date -u -v-3H +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
    --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Average,Maximum]' --output text \
    > results/piloto-<fecha>/cloudwatch-cpu-$id.tsv
done

git add results
git commit -m "results: piloto $(date +%F)"
git push
```

(En macOS, `date -v-3H` es "hace 3 horas". En Linux sería `date -d '-3 hours'`.)

Cada carpeta de corrida termina con: los tres resúmenes del loadtest, las
métricas cada 5 segundos, la CPU de cada máquina segundo a segundo, la CPU
según CloudWatch, la reconciliación, el estado final y las notas. Con eso se
puede rehacer cualquier tabla o gráfica del informe sin volver a medir.

## 10. Qué grabar y capturar

Los archivos del paso 9 son la evidencia principal: son datos crudos y
reproducibles. Lo visual es complemento para la presentación.

**Grabación de pantalla** (en Mac: `Cmd + Shift + 5`, "Grabar toda la
pantalla"). Una sola grabación por corrida, con la pantalla dividida así:

- Izquierda: la terminal del generador con el `loadtest` corriendo.
- Derecha arriba: la terminal con el `watch` de los `/metrics` de las dos
  instancias, donde se ve el reparto en vivo.
- Derecha abajo: una de las terminales de `vmstat` (la del motor es la más
  interesante: va al 100 % siempre).

Empezar a grabar antes del calentamiento y parar después del `sleep 90` de
relajación. Guardar el video con el mismo nombre de la carpeta de la corrida
(no se sube al repo: pesa demasiado; va a Drive con un enlace en `NOTAS.md`).

**Capturas de la consola de AWS**, al terminar cada corrida:

1. `EC2 → Target Groups → trading-tg-80 → Targets`: las instancias y su estado
   (2 healthy en A, 1 en B).
2. `CloudWatch → Metrics → EC2 → Per-Instance Metrics → CPUUtilization` con
   las tres instancias seleccionadas, periodo 1 minuto, últimas 3 horas. Se ve
   la meseta del normal, el pico y la bajada.
3. `CloudWatch → Metrics → NetworkELB → Per LB → ActiveFlowCount` y
   `HealthyHostCount` del `trading-nlb`, mismo rango.
4. `CloudFormation → Stacks → trading-nlb → Resources`: prueba de qué se creó.

Las capturas sí van al repo, en la misma carpeta de la corrida.

## 11. Al terminar la sesión (desde el Mac)

```bash
export AWS_PROFILE=arquisoft

# apagar el monitoreo detallado
aws ec2 unmonitor-instances --instance-ids i-03d62904b8f2f5b48 i-066240bbc580e697d i-0355dc1e06f770749

# apagar las instancias que se pagan (el motor es la que cuesta dinero encendida)
aws ec2 stop-instances --instance-ids i-03d62904b8f2f5b48 i-066240bbc580e697d i-0355dc1e06f770749 i-0517df006919e40f1
```

Si ya no se va a repetir el experimento, borrar el stack entero (NLB, réplica y
generador), **solo después** de haber bajado los resultados:

```bash
aws cloudformation delete-stack --stack-name trading-nlb
```

Lo que el stack **no** se lleva y se factura por GB-mes: la AMI y su snapshot
(`EC2 → AMIs → Anular registro`, después `EC2 → Snapshots → Eliminar`). Un NLB
olvidado son del orden de 16 USD/mes; una corrida entera cuesta menos de
0,10 USD. El costo de medir es despreciable, el de olvidar no.

## 12. Si algo falla

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `ssh` se queda colgado y expira | IP pública vieja, o el puerto 22 cerrado para tu IP | Repetir el paso 2 para sacar la IP de hoy |
| `Permission denied (publickey)` | Permisos del `.pem` o llave equivocada | `chmod 400 ~/.ssh/Arquisoft.pem` |
| El DNS del NLB no resuelve o no responde desde el Mac | Es lo esperado: el NLB es interno | Solo se alcanza desde la VPC, o sea desde el generador (ver paso 0) |
| Target `unhealthy` | La API aún arranca, o la base no responde | Esperar 1 min; luego `curl http://<ip-privada>/api/v1/ready` desde el generador |
| Ids de sesión distintos | La réplica arrancó con el motor en frío | Paso 3, el arreglo de la orden y el reinicio |
| Se reinició el motor (o se llamó a `/api/v1/engine/reset`) con los dos backends arriba | Split-brain: los dos detectan el reinicio, los dos rotan y cada uno cierra la sesión del otro | `docker compose restart api` **en las dos**, y volver a comparar los `session.id` del paso 3 antes de medir |
| `HTTP 400 ValidationError` al mandar una orden | Formato JSON equivocado | La API pública quiere `userId`/`assetId`/`price`/`quantity`, no `idUsuario`/`idActivo`/`tipo`. Ver el paso 3 bis |
| `loadtest` con `HTTP 502` | El motor no contesta o va saturado | Mirar el `vmstat` del motor y `curl http://172.31.21.117:8080/api/estadisticas` |
| `loadtest` con muchos `HTTP 503` | Backpressure: la cola de escritura llena | Es un resultado, no un error: anotarlo y seguir |
| `st` > 0 en `vmstat` | La instancia se quedó sin créditos de CPU | Esperar 10 min y repetir la corrida; anotarlo |
| `aws` responde con otra cuenta | No se exportó el perfil en esa terminal | `export AWS_PROFILE=arquisoft` |
