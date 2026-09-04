# syntax=docker/dockerfile:1
# ===========================================================================
# Backend de Persistencia de Trading — ARTI4109 Reto 1
#
# Imagen multi-etapa: las dependencias se resuelven aparte para que una
# edición de código no invalide la caché de `npm ci`.
#
#   docker build -t trading-persistence .
#   docker run --rm -p 3000:3000 --env-file .env --init trading-persistence
# ===========================================================================

# --------------------------------------------------------------------------
# Etapa 1 — dependencias de producción
# --------------------------------------------------------------------------
FROM node:22-alpine AS deps

WORKDIR /app

# Solo el manifiesto: mientras package.json y el lock no cambien, Docker
# reutiliza esta capa aunque haya cambiado todo el código.
COPY package.json package-lock.json ./

# `npm ci` instala exactamente lo que fija el lock (build reproducible).
# `--omit=dev` deja fuera las dependencias de desarrollo.
RUN npm ci --omit=dev && npm cache clean --force

# --------------------------------------------------------------------------
# Etapa 2 — runtime
# --------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# tini como PID 1: reparte las señales al proceso de Node y recoge los
# procesos zombis. Importante aquí, porque el apagado ordenado (vaciar la
# cola write-behind ante SIGTERM) depende de que la señal llegue de verdad.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY sql ./sql
COPY scripts ./scripts

# Los lotes que no se pueden escribir van a dead letter en disco; el
# directorio tiene que pertenecer al usuario sin privilegios.
RUN mkdir -p /app/logs && chown -R node:node /app/logs

# La imagen de Node ya trae el usuario `node` (uid 1000). Nunca root.
USER node

EXPOSE 3000

# Usa el propio endpoint de liveness. Se resuelve con `node` para no tener
# que meter curl en la imagen.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]

# El servidor aplica sus migraciones al arrancar (son idempotentes), así que
# no hace falta un paso previo en el despliegue.
CMD ["node", "src/server.js"]
