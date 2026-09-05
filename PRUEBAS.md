# PRUEBAS — Las dos pruebas de carga: tiempos, peticiones y criterios

> Qué se ejecuta exactamente, con qué tasa, cuánto dura y qué tiene que salir
> para darlo por bueno. El montaje y la operación están en
> [PILOTO.md](PILOTO.md); esto es solo el protocolo de las corridas.
> Los requisitos vienen de [EXPERIMENTO.md](EXPERIMENTO.md) §1.

## Las dos pruebas de un vistazo

| | **Prueba 1 — Carga sostenida** | **Prueba 2 — Pico** |
|---|---|---|
| Qué exige el enunciado | 500 ventas/min + 800 compras/min = **1300 órdenes/min** | **5000 emparejamientos/min** |
| Qué comprueba | Que en régimen normal se cumplen los tiempos de registro | Que el sistema aguanta la ráfaga y **se pone al día** después |
| Duración de la medición | 60 s | 60 s + 90 s de relajación |
| Calentamiento previo | 60 s (se descarta) | 60 s (se descarta) |

Ojo con la Prueba 2: el enunciado pide el pico en **emparejamientos**, no en
órdenes. No son lo mismo — ver *Cuántas peticiones son 5000 emparejamientos*.

## Criterios de aceptación

| # | Criterio | Origen |
|---|---|---|
| 1 | Registro de **venta**: p99 < 500 ms | Enunciado |
| 2 | Registro de **compra**: p99 < 300 ms | Enunciado |
| 3 | **p95 < 100 ms** y **p99 < 200 ms** | Criterio estricto del curso |
| 4 | Recuperación tras el pico ≤ 5 min | Criterio del curso |
| 5 | **0 órdenes perdidas**: `dropped: 0`, `deadLettered: 0`, cola de vuelta a 0 | Integridad |
| 6 | `reconcile.json` sin deriva contra el libro del motor | Integridad |

El criterio 3 es más exigente que el 1 y el 2, así que en la práctica es el que
manda. El `loadtest` solo marca `OK/FALLA` contra los criterios 1 y 2: **el 3
hay que comprobarlo a mano** leyendo `p95=` y `p99=` en la salida.

## Cuántas peticiones son 5000 emparejamientos

Un emparejamiento no es una petición: consume dos órdenes (o partes de dos).
Medido el 2026-09-05 en la infraestructura real:

```
1299 órdenes  →  441 emparejamientos     =  0,34 trades por orden
```

Luego **5000 emparejamientos/min ≈ 14 700 órdenes/min**, no 6500. Por eso la
Prueba 2 se corre en dos variantes, y en el informe hay que decir cuál se usó:

| Variante | Tasa | Peticiones en 60 s | Qué representa |
|---|---|---|---|
| **2a — pico 5×** | 6500 órdenes/min | 6 498 | Cinco veces la carga nominal. Rinde ~2 200 emparejamientos/min |
| **2b — pico del enunciado** | 14 724 órdenes/min | 14 724 | Apunta a los 5000 emparejamientos/min literales |

El ratio 0,34 depende del solape de precios, así que **hay que verificarlo en
cada corrida** (ver *Comprobar los emparejamientos logrados*). Si sale distinto,
se ajusta la tasa y se anota.

## Antes de empezar

```bash
# 1. Traerse la última versión de las guías
cd ~/Perssitencia-trading && git pull

# 2. Las dos sesiones deben coincidir (si no: PILOTO.md paso 3)
curl -s http://172.31.84.127/api/v1/status | grep -o '"session":{"id":"[^"]*"'
curl -s http://172.31.86.199/api/v1/status | grep -o '"session":{"id":"[^"]*"'

# 3. Carpeta de la corrida y URL
RUN=~/results/$(date +%F-%H%M)-P1-C; mkdir -p $RUN; cd $RUN
NLB=http://trading-nlb-3873526197343ac2.elb.us-east-1.amazonaws.com
N=6
URL=$NLB
```

Todo se ejecuta **dentro de la EC2 generadora** (`ssh -i ~/.ssh/Arquisoft.pem
ec2-user@<ip-pública-generador>`). El NLB es interno: desde un portátil no
responde.

**Por qué `N=6` contenedores y no uno:** el NLB reparte conexiones TCP, no
peticiones. Un solo contenedor mantiene una única conexión y toda la carga cae
en una máquina — medido: `original 1740 / réplica 0`. Detalle completo en
PILOTO.md §6.

---

## Prueba 1 — Carga sostenida

**Objetivo:** verificar los tiempos de registro en régimen estable.

| Parámetro | Valor |
|---|---|
| Tasa objetivo | 1300 órdenes/min |
| Contenedores (`N`) | 6 |
| Tasa por contenedor | 216 órdenes/min |
| Tasa real agregada | 1296 órdenes/min (−0,3 % por redondeo entero) |
| Duración | 60 s |
| **Peticiones totales** | **1296** (~797 compras / ~499 ventas) |

```bash
# Calentamiento — NO se reporta
for i in $(seq $N); do
  docker run --rm trading-persistence:latest node scripts/loadtest.js \
    --url $URL --rate 216 --duration 60 > 0-calentamiento-$i.txt &
done; wait

# Medición
for ip in 172.31.84.127 172.31.86.199; do
  echo -n "$ip  "; curl -s http://$ip/api/v1/metrics | grep -o '"enqueued":[0-9]*'
done | tee reparto-antes.txt

for i in $(seq $N); do
  docker run --rm trading-persistence:latest node scripts/loadtest.js \
    --url $URL --rate 216 --duration 60 > 1-sostenida-$i.txt &
done; wait

for ip in 172.31.84.127 172.31.86.199; do
  echo -n "$ip  "; curl -s http://$ip/api/v1/metrics | grep -o '"enqueued":[0-9]*'
done | tee reparto-despues.txt
```

**Qué anotar:** el peor p95 y p99 de los 6 contenedores (criterio 3), la suma de
`órdenes ok` y `fallidas`, y el reparto (la resta antes/después).

---

## Prueba 2 — Pico

**Objetivo:** ver si el sistema aguanta la ráfaga y, sobre todo, **cuánto tarda
en ponerse al día** cuando la ráfaga acaba.

| Parámetro | 2a — pico 5× | 2b — pico del enunciado |
|---|---|---|
| Tasa objetivo | 6500 órdenes/min | 14 724 órdenes/min |
| Tasa por contenedor (`N=6`) | 1083 | 2454 |
| Duración de carga | 60 s | 60 s |
| **Peticiones totales** | **6 498** | **14 724** |
| Relajación posterior | 90 s sin carga | 90 s sin carga |

```bash
RATE=1083     # 2a;  usar 2454 para 2b

# Estado de partida (para las restas)
curl -s http://172.31.21.117:8080/api/estadisticas > motor-antes.json
for ip in 172.31.84.127 172.31.86.199; do
  echo -n "$ip  "; curl -s http://$ip/api/v1/metrics | grep -o '"enqueued":[0-9]*'
done | tee reparto-antes.txt

for i in $(seq $N); do
  docker run --rm trading-persistence:latest node scripts/loadtest.js \
    --url $URL --rate $RATE --duration 60 > 2-pico-$i.txt &
done; wait

echo "FIN DE CARGA: $(date -u +%FT%TZ)" | tee fin-de-carga.txt

# Relajación: NO lanzar nada más. El muestreo del paso 4 de PILOTO sigue
# escribiendo metrics.ndjson cada 5 s; de ahí sale el tiempo de recuperación.
sleep 90

curl -s http://172.31.21.117:8080/api/estadisticas > motor-despues.json
```

### Medir la recuperación (criterio 4)

El tiempo de recuperación es **desde `FIN DE CARGA` hasta el primer instante en
que `queueDepth` vuelve a 0 en las dos instancias**:

```bash
grep -o '"t":"[^"]*"\|"queueDepth":[0-9]*\|"node":"[^"]*"' metrics.ndjson | paste - - - | tail -40
```

Si `queueDepth` nunca subió de 0, la recuperación fue inmediata — pero eso
significa que el pico no llegó a estresar nada, y hay que decirlo así en el
informe en vez de venderlo como un aprobado holgado.

### Comprobar los emparejamientos logrados

Con esto se sabe si la variante 2b alcanzó de verdad los 5000/min:

```bash
python3 -c "
import json
a=json.load(open('motor-antes.json')); d=json.load(open('motor-despues.json'))
t=d['tradesEmparejados']-a['tradesEmparejados']
o=d['ordenesProcesadasTotales']-a['ordenesProcesadasTotales']
print(f'órdenes={o}  emparejamientos={t}  ratio={t/o:.3f}  emparejamientos/min={t*60/60:.0f}')"
```

---

## La matriz de corridas

Cada prueba se repite en las **tres configuraciones** de INFRA.md, porque con
solo dos no se puede separar el peaje del balanceador de la ganancia de escalar:

| | A — directo | B — NLB, 1 target | C — NLB, 2 targets |
|---|---|---|---|
| `URL` | `http://172.31.84.127` | `$NLB` | `$NLB` |
| Preparación | ninguna | desregistrar la réplica | las dos registradas |
| Prueba 1 | ☐ | ☐ | ☐ |
| Prueba 2 | ☐ | ☐ | ☐ |

**Peaje del balanceador = B − A. Ganancia de escalar = C − B.**

Cómo cambiar de configuración: PILOTO.md §8. Una carpeta por celda, nombrada
`<fecha>-P<1|2>-<A|B|C>`.

## Plantilla de resultados

Una fila por corrida, en `NOTAS.md` de cada carpeta:

```
Prueba (1 sostenida | 2a pico 5x | 2b pico enunciado):
Configuración (A directo | B NLB 1 | C NLB 2):
N contenedores:                    Tasa por contenedor:
Órdenes ok (suma de los N):        Fallidas (suma):
Peor p95  compra / venta:                    (criterio: < 100 ms)
Peor p99  compra / venta:                    (criterio: < 200 ms / 300 / 500)
Reparto enqueued  original / réplica:
Emparejamientos logrados:                    emparejamientos/min:
maxQueueDepth  original / réplica:
Recuperación (s desde FIN DE CARGA a queueDepth 0):
dropped / deadLettered / conflicts:
Discrepancias en reconcile.json:
Observaciones:
```

**Los percentiles no se promedian.** De los N contenedores se reporta el
**peor** p95 y p99 como cota superior; `n`, throughput y fallidas sí se suman:

```bash
grep -h '^  BUY'  1-sostenida-*.txt | sed 's/.*p99=\([0-9.]*\)ms.*/\1/' | sort -g | tail -1
grep -h '^  SELL' 1-sostenida-*.txt | sed 's/.*p99=\([0-9.]*\)ms.*/\1/' | sort -g | tail -1
```

## Evidencia que se guarda por corrida

| Archivo | Qué es |
|---|---|
| `0-calentamiento-*.txt` | Descartado, pero se guarda |
| `1-sostenida-*.txt` / `2-pico-*.txt` | Los N informes del `loadtest` |
| `reparto-antes.txt` / `reparto-despues.txt` | Prueba de que el balanceador repartió |
| `motor-antes.json` / `motor-despues.json` | Emparejamientos logrados |
| `fin-de-carga.txt` | Marca temporal para la recuperación |
| `metrics.ndjson` | Cola y conteos cada 5 s (paso 4 de PILOTO) |
| `cpu-*.txt` | `vmstat` de cada máquina |
| `reconcile.json` | Integridad contra el libro del motor |
| `NOTAS.md` | La plantilla de arriba, rellena |

Y al terminar, **bajarlo todo al portátil y subirlo al repo** (PILOTO.md §9):
el generador y la réplica son desechables y `delete-stack` borra sus discos.

## Notas conocidas

- `reconcile.json` mostrará **una** entrada en `unknownToBackend`: la orden id 4
  del motor (venta de 1 a 999), inyectada el 2026-09-05 para reparar las
  sesiones. Es esperada. Al ser una venta a 999 y operar el `loadtest` entre 50
  y 70, nunca cruza y no altera las medidas.
- El `loadtest` reparte la carga uniforme entre los 5 activos y no hace llegadas
  Poisson ni fases automáticas. Para una corrida larga con activos calientes
  haría falta otro generador.
