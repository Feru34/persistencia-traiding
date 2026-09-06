# PENDIENTE — Subir el motor de 5 a 20 activos

> Para quien tenga el código fuente de `MatchineEngine.jar`. El enunciado del
> Experimento 1 concentra la carga en 2-3 de **20** activos; el motor actual
> solo admite **5** (`idActivo` de 0 a 4) y ese límite está **compilado**, no
> configurable: las únicas propiedades que expone son `matching.strategy`,
> `matching.periodic.interval.ms` y `matching.queue.capacity`.
>
> Hallazgos obtenidos desenmontando el JAR con `javap -p -c` sobre las 116
> clases (`co.edu.uniandes.mati.arqsol.reto1.*`), el 2026-09-05.

## No bloquea el experimento

Con 2 activos calientes de 5 ya se reproduce la **contención sobre un mismo
libro de órdenes**, que es el fenómeno que el enunciado quiere medir. Lo único
que cambia es el tamaño del universo. Si el JAR nuevo no llega a tiempo, se
declara la desviación en el informe y el Experimento 1 queda igualmente cerrado.

## Son exactamente dos sitios

Barrido de las 116 clases buscando `iconst_5` / `bipush 5` / `iconst_4`: solo
aparecen en tres clases, y una es un falso positivo.

### 1. `config/ConfiguracionMotor.java` → método `librosOrdenes()`

Crea el arreglo de libros y lo llena. El bytecode:

```
 0: iconst_5
 1: anewarray  LibroOrdenes      ← new LibroOrdenes[5]
 5: iconst_0
 8: iconst_5
 9: if_icmpge                    ← for (int i = 0; i < 5; i++)
18: sipush     10000             ← new LibroOrdenes(10000)  capacidad por libro
```

Equivale a:

```java
LibroOrdenes[] libros = new LibroOrdenes[5];
for (int i = 0; i < 5; i++) {
    libros[i] = new LibroOrdenes(10000);
}
return libros;
```

### 2. `rest/ControladorHFT.java` → validación de entrada

```
11: iconst_4
12: if_icmple
18: ldc  "idActivo inválido. Debe estar entre 0 y 4."
```

Equivale a:

```java
if (req.idActivo() < 0 || req.idActivo() > 4) {
    return ResponseEntity.badRequest().body("idActivo inválido. Debe estar entre 0 y 4.");
}
```

### Falso positivo, no tocar

`io/PublicadorAsincrono.java` también tiene `iconst_4` y `iconst_5`, pero son
**índices de un arreglo de argumentos** de `String.format` (van seguidos de
`aastore` en las posiciones 3, 4 y 5). No tienen relación con los activos.

## Cómo cambiarlo: mejor una propiedad que un 20 a pelo

`ConfiguracionMotor` **ya lee propiedades** con este patrón, en el mismo
archivo:

```java
int capacidad = Integer.parseInt(
    env.getProperty("matching.queue.capacity", "131072"));
```

Así que lo natural es añadir una cuarta propiedad con el mismo estilo, y que no
haya que recompilar la próxima vez:

```java
// ConfiguracionMotor.java
public static int numActivos(Environment env) {
    return Integer.parseInt(env.getProperty("matching.activos.count", "5"));
}

@Bean
public LibroOrdenes[] librosOrdenes() {
    int n = numActivos(env);
    LibroOrdenes[] libros = new LibroOrdenes[n];
    for (int i = 0; i < n; i++) {
        libros[i] = new LibroOrdenes(10000);
    }
    return libros;
}
```

```java
// ControladorHFT.java — el límite y el mensaje, derivados de la propiedad
int max = numActivos(env) - 1;
if (req.idActivo() < 0 || req.idActivo() > max) {
    return ResponseEntity.badRequest()
        .body("idActivo inválido. Debe estar entre 0 y " + max + ".");
}
```

Y en `application.properties`, junto al JAR:

```properties
matching.activos.count=20
```

Con el valor por defecto en `5`, un JAR nuevo sin tocar el `.properties` se
comporta igual que el actual: no rompe nada de lo ya medido.

## ⚠️ Aviso de memoria — leer antes de desplegar

El motor arranca con **`-Xmx512m`** en un `t3.micro` de 1 GB
([INFRA.md](INFRA.md) → unidad `matching-engine`), y hoy
`matching.queue.capacity` está en **1 048 576**.

Pasar de 5 a 20 libros **cuadruplica** las estructuras por libro (cada uno se
crea con capacidad 10 000). Si el motor no arranca o muere por `OutOfMemory`,
hay tres salidas, de menos a más intrusiva:

1. Bajar `matching.queue.capacity` (p. ej. a `262144`) — es una potencia de 2 y
   se cambia en el `.properties`, sin recompilar.
2. Subir el heap: `-Xmx768m` en el `ExecStart` de la unidad systemd.
3. Cambiar la instancia del motor a una con más memoria — **esto sí cuesta
   dinero**, así que es el último recurso.

Comprobar tras desplegar:

```bash
systemctl status matching-engine
journalctl -u matching-engine -n 50 | grep -i "outofmemory\|error"
curl -s http://172.31.21.117:8080/api/estadisticas
```

## Qué hay que cambiar en este repo cuando llegue el JAR nuevo

Tres cosas, ninguna cuesta nada en AWS:

| Archivo | Ahora | Con 20 activos |
|---|---|---|
| [`src/routes/schemas.js`](src/routes/schemas.js) línea 43 | `assetId: { minimum: 0, maximum: 4 }` | `maximum: 19` |
| [`sql/002_seed_assets.sql`](sql/002_seed_assets.sql) | 5 filas (`ECO`, `PFB`, `ISA`, `GEB`, `CLH`) | 20 filas |
| `.env` de las dos EC2 de persistencia | `ASSET_COUNT=5` | `ASSET_COUNT=20` |

`ASSET_COUNT` lo leen tanto la API ([`src/config/index.js`](src/config/index.js)
línea 77) como el generador de carga
([`scripts/loadtest.js`](scripts/loadtest.js) línea 23), así que con esa
variable el `--hotAssets` pasa a poder elegir entre 0 y 19.

Después: reconstruir la imagen y redesplegar en las dos instancias, y hacer la
**puesta a cero** de [PRUEBAS.md](PRUEBAS.md) — la migración `002` no borra los
activos viejos (`ON CONFLICT DO NOTHING`), pero sí conviene arrancar el
experimento con base y motor limpios.

## Verificación de que el JAR nuevo funciona

```bash
# debe aceptar el activo 19 (antes daba 400)
curl -s -X POST http://172.31.21.117:8080/api/ordenes \
  -H 'Content-Type: application/json' \
  -d '{"idUsuario":1,"idActivo":19,"tipo":1,"precio":999,"cantidad":1}'

# y seguir rechazando el 20
curl -s -X POST http://172.31.21.117:8080/api/ordenes \
  -H 'Content-Type: application/json' \
  -d '{"idUsuario":1,"idActivo":20,"tipo":1,"precio":999,"cantidad":1}'
```

Recordatorio del contrato del motor: campos en **español** y `tipo` (0 = compra,
1 = venta); responde el id en **texto plano**, no en JSON. La API de
persistencia usa el otro formato — ver `PILOTO.md` §3 bis.
