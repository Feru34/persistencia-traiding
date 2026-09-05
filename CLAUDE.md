# CLAUDE.md

Backend Node.js de **persistencia** de un sistema de trading (ARTI4109 Reto 1,
MATI Uniandes). Registra órdenes, las inyecta en un motor de matching externo
(`MatchineEngine.jar`, Spring Boot, puerto 8080, **en otra máquina**) y persiste
en PostgreSQL/RDS todo lo que ocurre. **El emparejamiento no pasa por aquí.**

## Dónde está cada cosa

La documentación está dividida a propósito; antes de escribir en una, comprobar
que el tema no pertenece a otra:

| Documento | Alcance | No poner aquí |
|---|---|---|
| [README.md](README.md) | El proyecto: decisiones de diseño, arquitectura, contrato del motor, API, modelo de datos, Docker, variables | Nada específico de AWS ni resultados de medición |
| [INFRA.md](INFRA.md) | AWS: instancias, IPs, Security Groups, arranque automático, operación remota, balanceador (NLB + CloudFormation), costos, desmontaje | Detalles de la API o del dominio |
| [EXPERIMENTO.md](EXPERIMENTO.md) | La medición: objetivo, protocolo, resultados, hallazgos, límites | Instrucciones de montaje (van en INFRA.md) |
| [PILOTO.md](PILOTO.md) | Guía operativa paso a paso para correr el piloto del NLB a mano desde un Mac y guardar la evidencia | Explicaciones de diseño (README), de infraestructura (INFRA) o el protocolo de las corridas (PRUEBAS) |
| [PRUEBAS.md](PRUEBAS.md) | Las dos pruebas de carga: tasas, número de peticiones, duraciones, criterios de aceptación, matriz A/B/C y plantilla de resultados | Cómo se monta la infra (INFRA) o cómo se opera el piloto (PILOTO) |
| [PENDIENTES.md](PENDIENTES.md) | Traspaso de contexto y tareas abiertas | Documentación estable |
| `infra/` | Plantillas de IaC (CloudFormation) | |

## Invariantes que no son obvias en el código

- **El dinero se guarda en centavos (`BIGINT`)**, nunca en float. `src/domain/money.js`.
  La API expone decimales; la base y el motor trabajan en centavos.
- **`tipo: 0` = COMPRA, `tipo: 1` = VENTA** en el motor. Verificado ejecutando el
  JAR, no supuesto. `idActivo` debe estar entre 0 y 4.
- **El motor devuelve el id de orden en texto plano**, no en JSON: hay que extraerlo.
- **`orders.id` y `trades.id` son UUIDv7 generados en la aplicación**, no en la
  base: en modo `async` hay que responder antes de que ocurra el `INSERT`.
- **Sesiones del motor.** El contador de ids del motor vuelve a 1 cada vez que
  arranca. Cada ejecución es una fila en `engine_sessions`, y las órdenes son
  únicas por `(sesión, id del motor)`. Sin eso, la orden #1 de hoy se
  confundiría con la #1 de ayer. Toda la lógica está en
  `src/services/sessionManager.js` — leerlo antes de tocar nada relacionado.
- **El `TradeEvent` solo trae dos ids de orden**: ni activo, ni usuarios, ni
  timestamp. El backend lo reconstruye cruzando contra las órdenes de la sesión.
- **Solo los trades realmente insertados** (los que devuelve `RETURNING` tras el
  `ON CONFLICT DO NOTHING`) mueven órdenes, posiciones y saldos. Un reenvío no
  vuelve a descontar nada.
- **El bridge es un singleton.** El motor publica los trades por WebSocket en
  broadcast: dos bridges reciben cada trade dos veces. Las réplicas detrás de un
  balanceador van con `BRIDGE_REPLICAS=0`.

## Convenciones de configuración

- **Variables `*_DOCKER`.** Dentro de un contenedor `localhost` es el propio
  contenedor, y el `.env` suele tener credenciales de la RDS. Por eso el compose
  sobreescribe con `PGHOST_DOCKER`, `ENGINE_BASE_URL_DOCKER`, `PORT_DOCKER`…
  Al añadir una variable que valga distinto dentro de Docker, seguir ese patrón
  en vez de duplicar el `.env`.
- **Puertos.** En el despliegue de AWS el backend escucha en el **80**
  (`PORT_DOCKER=80`, `PORT_HOST=80`). `PORT` sigue en 3000 para `npm start`
  fuera de Docker, donde un usuario sin privilegios no puede abrir un puerto bajo.
- **Entre las dos EC2 se habla siempre por IP privada**, que no cambia al apagar
  y prender. Las públicas sí cambian y solo sirven para entrar desde fuera.

## Comandos

En la EC2 **no hay Node instalado**: todo lo que sea `node` se ejecuta dentro
del contenedor.

```bash
docker compose up -d --build          # levantar
docker compose logs -f api bridge
curl localhost/api/v1/status          # base, motor, sesión, cola, conteos
docker compose exec api node scripts/loadtest.js --url http://127.0.0.1:80 --rate 1300 --duration 60
npm test                              # en local, no en la EC2
```

Para reiniciar el motor usar **`POST /api/v1/engine/reset`**, nunca un `curl`
directo a `/api/reset` del motor: el reset deja su estado en blanco y sin rotar
la sesión los trades nuevos se asociarían a órdenes viejas.
