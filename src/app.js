import { createRequire } from 'node:module';
import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config/index.js';
import { schemas } from './routes/schemas.js';
import ordersRoutes from './routes/orders.js';
import tradesRoutes from './routes/trades.js';
import marketRoutes from './routes/market.js';
import usersRoutes from './routes/users.js';
import systemRoutes from './routes/system.js';
import { EngineError } from './services/engineClient.js';
import { ValidationError, BackpressureError } from './services/orderService.js';

const require = createRequire(import.meta.url);

// pino-pretty es dependencia de desarrollo y no viaja en la imagen de
// producción (`npm ci --omit=dev`). Se comprueba en vez de asumirla, para que
// arrancar el contenedor con NODE_ENV=development no reviente.
const prettyAvailable = (() => {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
})();

export async function buildApp(options = {}) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: config.env === 'development' && prettyAvailable
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
        : undefined,
    },
    // Los requests de trading son pequeños; recortar el límite protege memoria.
    bodyLimit: 2 * 1024 * 1024,
    // El log por request domina la latencia bajo carga; solo se activa en debug/trace.
    logController: new LogController({
      disableRequestLogging: config.logLevel !== 'debug' && config.logLevel !== 'trace',
    }),
    ...options,
  });

  await app.register(cors, { origin: true });

  // --- OpenAPI -------------------------------------------------------------
  // La especificación se deriva de los mismos esquemas que validan las
  // peticiones, así que el contrato publicado no se puede desincronizar del
  // que se aplica de verdad.
  await app.register(swagger, {
    // Sin esto, los esquemas compartidos salen en la especificación como
    // def-0, def-1... en vez de Order, Trade, etc.
    refResolver: {
      buildLocalReference(json, _baseUri, _fragment, i) {
        return json.$id || `def-${i}`;
      },
    },
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Backend de Persistencia de Trading',
        description:
          'Persistencia del estado de trading para el Reto 1 de ARTI4109.\n\n'
          + '**El matching NO ocurre aquí**: corre en `MatchineEngine.jar`, en otra máquina. '
          + 'Este servicio registra las ofertas, las inyecta en el motor y persiste lo que ocurre.\n\n'
          + '### Convenciones\n'
          + '- Los precios se envían y se devuelven en **unidades decimales** (`50.25`), con '
          + 'máximo 2 decimales. Internamente se guardan en centavos (`BIGINT`) para no '
          + 'arrastrar errores de punto flotante.\n'
          + '- `assetId` va de **0 a 4**: es el rango que admite el motor.\n'
          + '- En el motor `tipo 0` es COMPRA y `tipo 1` es VENTA; esta API usa '
          + '`side: "BUY" | "SELL"` y hace la traducción.\n'
          + '- Un `503` significa backpressure (cola de persistencia saturada), no un fallo: '
          + 'la petición se puede reintentar.',
        version: '1.0.0',
      },
      servers: [{ url: '/', description: 'Este servidor' }],
      tags: [
        { name: 'Órdenes', description: 'Registro de ofertas de compra y de venta' },
        { name: 'Trades', description: 'Ingesta y consulta de emparejamientos' },
        { name: 'Mercado', description: 'Estado de las acciones, libro de órdenes y resúmenes' },
        { name: 'Usuarios', description: 'Traders, saldo en efectivo y portafolio' },
        { name: 'Operación', description: 'Salud, métricas, motor, sesiones y reconciliación' },
      ],
      components: {
        securitySchemes: {
          ingestToken: {
            type: 'apiKey',
            name: 'X-Ingest-Token',
            in: 'header',
            description: 'Token compartido para la ingesta de trades. Configurable con INGEST_TOKEN.',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, displayRequestDuration: true },
  });

  for (const schema of schemas) app.addSchema(schema);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ValidationError) {
      return reply.code(400).send({ error: 'ValidationError', message: error.message, details: error.details });
    }
    if (error instanceof BackpressureError) {
      return reply.code(503).send({ error: 'Backpressure', message: error.message });
    }
    if (error instanceof EngineError) {
      // 4xx del motor = la orden es inválida para él -> culpa del cliente.
      const status = error.status >= 400 && error.status < 500 ? 400 : 502;
      return reply.code(status).send({ error: 'EngineError', message: error.message });
    }
    if (error.validation) {
      return reply.code(400).send({ error: 'ValidationError', message: error.message, details: error.validation });
    }
    request.log.error({ err: error }, 'error no controlado');
    return reply.code(error.statusCode ?? 500).send({
      error: 'InternalServerError',
      message: config.env === 'production' ? 'Error interno' : error.message,
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: 'NotFound', message: `Ruta no encontrada: ${request.method} ${request.url}` }));

  await app.register(async (api) => {
    await api.register(ordersRoutes);
    await api.register(tradesRoutes);
    await api.register(marketRoutes);
    await api.register(usersRoutes);
    await api.register(systemRoutes);
  }, { prefix: '/api/v1' });

  app.get('/', { schema: { hide: true } }, async () => ({
    service: 'trading-persistence',
    description: 'Backend de persistencia de trading — el matching corre en otra máquina',
    persistMode: config.persist.mode,
    docs: '/docs',
    openapi: '/docs/json',
  }));

  return app;
}

export default buildApp;
