# Enunciado de los dos experimentos (escala real)

Este documento fija, textualmente y sin recortar, los dos experimentos que
pide el enunciado del reto. Es la referencia de la que se derivan las
versiones piloto/recortadas documentadas en [EXPERIMENTO.md](EXPERIMENTO.md),
[PILOTO.md](PILOTO.md) y `PRUEBAS.txt`. Ninguna de esas versiones ejecuta
esto literal (duraciones menores, sin réplicas elásticas reales, sin
snapshot precargado); ver cada documento para las diferencias concretas
frente a lo que sigue.

---

## Experimento 1 — Escalabilidad horizontal ante picos

Comparación A/B:

- **Variante A**: N réplicas elásticas de Recepción de Órdenes.
- **Variante B**: 1 sola réplica de Recepción de Órdenes.

### Protocolo

1. Sistema funcionando normal durante **10 minutos**.
2. En menos de **10 segundos**, subir la carga a **5 veces** lo normal y
   sostenerla así **30 minutos seguidos**, simulando un pico real de
   mercado.
3. **Activos calientes**: la carga del pico no se reparte igual entre los
   20 activos; se concentra en **2 o 3**, porque así ocurre en la vida
   real — todos quieren comprar/vender la misma acción a la vez.
4. Bajar la carga otra vez y observar el sistema **15 minutos** para ver
   cómo se relaja.

**Prueba corta previa**: antes de correr la prueba completa, correr una
prueba corta para confirmar que un solo activo caliente (el que recibe más
carga) puede ser atendido por un solo procesador sin ayuda. Sin este paso no
se puede distinguir si el sistema falla por mal diseño o porque se le pidió
algo imposible.

### Métricas

- Cuánto tarda el sistema en ponerse al día después del pico (debe ser
  **3 minutos o menos**).
- Si los tiempos de respuesta se mantienen dentro de lo esperado: **95 %
  de las veces menos de 100 ms**, **99 % de las veces menos de 200 ms**.

---

## Experimento 2 — Persistencia síncrona vs asíncrona

Comparación A/B — única diferencia entre ambas variantes:

- **Variante A**: persistencia asíncrona, write-behind.
- **Variante B**: persistencia síncrona, commit durable antes de confirmar
  el match.

### Protocolo

- **5 réplicas por variante**, alternando **A/B/A/B** para neutralizar
  deriva del ambiente.
- Cada corrida: **30 minutos** a **16.7 TPS** con llegadas Poisson.
- **5 minutos de warm-up** descartados al inicio de cada corrida.
- Corre sobre un **snapshot precargado de 10 000 órdenes por símbolo**.

**Componente modificado**: el punto de persistencia dentro de Registro de
Órdenes/Libro de Órdenes (asíncrono en A, síncrono en B). Se instrumenta con
timestamps en:

- **T1** — orden aceptada
- **T2** — ingreso
- **T3** — fin de espera en cola
- **T4** — match materializado

### Métricas

- **Latencia de negocio T4−T1** (p50/p95/p99/p99.9), desglosada por etapa
  para localizar dónde se concentra el tiempo si el criterio no se cumple:
  - T2−T1: ingreso
  - T3−T2: espera en cola
  - T4−T3: emparejamiento
- **Rendimiento efectivo sostenido**.
- **Tasa de error**.
- **Matches confirmados aún no persistidos**, validada con una **prueba de
  fallo**: matar el proceso a mitad de corrida para confirmar cuántos
  matches confirmados se pierden realmente, no solo estimarlo de forma
  pasiva.

---

## Cómo correrlos con las herramientas actuales

El generador (`scripts/loadtest.js`) y el protocolo operativo (`PRUEBAS.txt`,
`PILOTO.md`) ya cubren la mecánica base (contenedores, NLB, puesta a cero,
métricas). Lo que sigue reutiliza esos comandos ajustando duraciones a escala
real. Donde el generador no da para más, se marca explícitamente **[FALTA]**
— correr el comando igual da un resultado, pero no valida lo que pide el
enunciado.

### Experimento 1 — réplicas + pico

Variante A (N réplicas) y B (1 réplica) son las configuraciones **C** y **A**
de la matriz de `PRUEBAS.txt` (NLB con las dos instancias vs. IP directa a
la original). Puesta a cero primero (`PRUEBAS.txt`, sección "Puesta a cero").

```bash
# variante B: 1 sola réplica, sin NLB
URL=http://172.31.84.127
# variante A: N réplicas, vía NLB (las dos instancias registradas)
URL=$NLB

RUN=~/results/$(date +%F-%H%M)-EXP1-A; mkdir -p $RUN; cd $RUN   # o -B
N=6

# 10 min de régimen normal (1300 órdenes/min repartidas en N contenedores)
for i in $(seq $N); do
  docker run --rm trading-persistence:latest node scripts/loadtest.js \
    --url $URL --rate 216 --duration 600 > 0-normal-$i.txt &
done; wait

echo "INICIO PICO: $(date -u +%FT%TZ)" | tee inicio-pico.txt

# pico 5x, 30 min = 1800 s (6500 órdenes/min agregado; ver PRUEBAS.txt
# para el porqué de este número frente al 5000 emparejamientos/min literal)
RATE_PICO=1083
for i in $(seq $N); do
  docker run --rm trading-persistence:latest node scripts/loadtest.js \
    --url $URL --rate $RATE_PICO --duration 1800 > 1-pico-$i.txt &
done; wait

echo "FIN DE CARGA: $(date -u +%FT%TZ)" | tee fin-de-carga.txt
sleep 900   # 15 min de relajación

# recuperación: igual que "Prueba 2" de PRUEBAS.txt
grep -o '"t":"[^"]*"\|"queueDepth":[0-9]*\|"node":"[^"]*"' metrics.ndjson | paste - - -
```

**Resumen agregado de los N contenedores** (cada uno imprime su propio
`=== Resultados ===`; hay que sumar órdenes y quedarse con el PEOR p95/p99,
nunca promediar — ver `PRUEBAS.txt` línea 310). Correr después de cada
`wait`, cambiando el prefijo de archivo (`0-normal-*.txt`, `1-pico-*.txt`):

```bash
PREFIX=0-normal   # o 1-pico, etc., según la tanda que estés resumiendo

echo "=== resumen agregado ($PREFIX) ==="
echo "ordenes ok      : $(grep -h 'órdenes ok' $PREFIX-*.txt | grep -o '[0-9]*' | paste -sd+ | bc)"
echo "ordenes fallidas: $(grep -h 'órdenes fallidas' $PREFIX-*.txt | grep -o '[0-9]*' | paste -sd+ | bc)"
echo "peor p95 BUY : $(grep -h '^  BUY'  $PREFIX-*.txt | sed 's/.*p95=\([0-9.]*\)ms.*/\1/' | sort -g | tail -1) ms"
echo "peor p99 BUY : $(grep -h '^  BUY'  $PREFIX-*.txt | sed 's/.*p99=\([0-9.]*\)ms.*/\1/' | sort -g | tail -1) ms"
echo "peor p95 SELL: $(grep -h '^  SELL' $PREFIX-*.txt | sed 's/.*p95=\([0-9.]*\)ms.*/\1/' | sort -g | tail -1) ms"
echo "peor p99 SELL: $(grep -h '^  SELL' $PREFIX-*.txt | sed 's/.*p99=\([0-9.]*\)ms.*/\1/' | sort -g | tail -1) ms"
```

**✅ Activos calientes — implementado.** `scripts/loadtest.js` acepta
`--hotAssets 0,1` y `--hotShare 0.8` (0.8 por defecto cuando se pasan
calientes). Verificado sobre 200 000 tiradas: sin los flags el reparto sigue
uniforme (~20 % por activo, comportamiento idéntico al anterior); con
`--hotAssets 0,1 --hotShare 0.8` sale 39,8 / 40,2 / 6,7 / 6,6 / 6,7 %.

Añádelos a los `docker run` del bloque de arriba, en la tanda de pico:

```bash
for i in $(seq $N); do
  docker run --rm trading-persistence:latest node scripts/loadtest.js \
    --url $URL --rate $RATE_PICO --duration 1800 \
    --hotAssets 0,1 --hotShare 0.8 > 1-pico-$i.txt &
done; wait
```

**Desviación frente al enunciado, a declarar en el informe:** el enunciado
concentra la carga en 2-3 de **20** activos; aquí son 2 de **5**, porque el
motor solo admite `idActivo` de 0 a 4 y ese límite está compilado en
`MatchineEngine.jar` (sus únicas propiedades son `matching.strategy`,
`matching.periodic.interval.ms` y `matching.queue.capacity`). Subirlo a 20
exige recompilar el motor desde su código Java, que no está en este repo. El
fenómeno que se quiere medir —contención sobre un mismo libro de órdenes— se
reproduce igual con 2 de 5.

**[FALTA] Prueba corta previa.** Antes de la corrida completa: repetir el
bloque de pico pero apuntando solo al activo caliente elegido, con **1 sola
réplica** (`URL=http://172.31.84.127`), duración corta (2-3 min), y
confirmar que aguanta antes de comprometer 40 min de corrida completa.
Necesita el mismo patch de activos calientes.

### Experimento 2 — síncrono vs asíncrono

`PERSIST_MODE` ya existe como variable (ver `EXPERIMENTO.md` sección 10,
"Reproducir el experimento") — cambiar entre `async`/`sync` y reiniciar el
backend es lo único que distingue las variantes A/B.

> **Cuidado: `PERSIST_MODE=sync docker compose up …` NO funciona.** El bloque
> `environment:` del `docker-compose.yml` no lista `PERSIST_MODE`, así que
> prefijarlo en la línea de comandos se lo pasa al CLI de compose pero **no
> entra al contenedor**: dentro sigue leyéndose del `env_file` (`.env`). El
> resultado es una corrida "variante B" que en realidad sigue en `async`, sin
> dar ningún error. Hay que editar el `.env`, como indica
> [EXPERIMENTO.md](EXPERIMENTO.md) §10.

```bash
# en la EC2 original (~/persistencia-traiding), alternando A/B/A/B

# variante A — asíncrona
sed -i 's/^PERSIST_MODE=.*/PERSIST_MODE=async/' .env
grep -q '^PERSIST_MODE=' .env || echo 'PERSIST_MODE=async' >> .env
docker compose up -d --force-recreate api

# variante B — síncrona
sed -i 's/^PERSIST_MODE=.*/PERSIST_MODE=sync/' .env
docker compose up -d --force-recreate api
```

**Verificar el modo activo antes de cada corrida** — si no coincide con la
variante que crees estar midiendo, la corrida no vale:

```bash
curl -s localhost/api/v1/metrics | grep -o '"persistMode":"[^"]*"'
```

Notas: `--force-recreate` en vez de `--build`, porque el código no cambia entre
variantes y construir en un `t3.micro` es lento y puede quedarse sin memoria.
Y **al terminar hay que volver a `async`**, que es el modo por defecto del
despliegue.

Carga por corrida: 16.7 TPS ≈ 1002 órdenes/min, 30 min, con 5 min de
warm-up descartados:

```bash
docker run --rm trading-persistence:latest node scripts/loadtest.js \
  --url $URL --rate 1002 --duration 300 > 0-warmup.txt   # descartado

docker run --rm trading-persistence:latest node scripts/loadtest.js \
  --url $URL --rate 1002 --duration 1800 > 1-medicion.txt
```

**✅ Llegadas Poisson — implementado.** `--arrivals poisson` (por defecto
`fixed`, que conserva el comportamiento anterior). Usa espera exponencial
`-ln(U)·media` reprogramada en cada llegada; `setInterval` no vale porque su
periodo es constante por definición.

Verificado sobre 200 000 muestras con media objetivo 46,15 ms (= 1300/min):
media medida 46,10 ms —**la tasa se conserva**— pero desviación típica 46,14 ms
frente a 0 del intervalo fijo. El 9,5 % de los huecos son menores que un
décimo de la media (ráfagas) y el 5 % mayores que el triple (pausas). Eso es lo
que forma colas y lo que el metrónomo no reproduce.

```bash
docker run --rm trading-persistence:latest node scripts/loadtest.js \
  --url $URL --rate 1002 --duration 1800 --arrivals poisson > 1-medicion.txt
```

**[FALTA] Snapshot precargado de 10 000 órdenes/símbolo.** Hay que sembrar
la base antes de cada corrida (script de carga masiva aparte; no existe
hoy). Sin esto el libro arranca vacío y no representa el escenario real.

**[FALTA] Timestamps T1-T4 y latencia de negocio.** El loadtest solo mide
T1 (request) a la respuesta HTTP de registro — eso es la latencia de
*registro*, no T4-T1 (hasta el match materializado). Para T2/T3/T4 hace
falta instrumentar `src/services/orderService.js` y el bridge
(`src/services/sessionManager.js` context) con timestamps por etapa y
correlacionarlos por id de orden en el análisis posterior — no está hecho.

**[FALTA] Prueba de fallo (matches perdidos).** Matar el proceso `api` a
mitad de corrida (`docker kill trading-api` o `pkill -9 node` dentro del
contenedor) y comparar, tras reiniciar, los matches que el motor reporta
como confirmados contra los que quedaron persistidos en `trades`. Es un
procedimiento manual, no un flag del loadtest.

### Orden sugerido para no perder tiempo

1. ~~Patchear `loadtest.js` (activos calientes + Poisson)~~ — **hecho**.
2. Escribir el script de snapshot (10 000 órdenes/símbolo).
3. Instrumentar T1-T4 — es el cambio más grande; sin él el Experimento 2 no
   tiene su métrica principal.
4. Recién ahí correr las variantes largas (30-40 min cada una): son caras
   en tiempo de EC2 encendida, no vale la pena repetirlas por partes.
