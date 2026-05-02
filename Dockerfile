# Bot service para Railway / Fly.io / cualquier docker host.
# Imagen liviana basada en Node 20 alpine. La sesión de Baileys persiste
# en /app/auth — Railway monta ahí un volumen persistente, así
# sobrevive a redeploys y restarts.

FROM node:20-alpine

WORKDIR /app

# Dependencias: instalamos también dev deps porque corremos directo con
# tsx (sin build a JS). Para una imagen aún más chica se puede compilar
# y dropear devDependencies — lo dejamos para una v2.
COPY package*.json ./
RUN npm install --include=dev

COPY tsconfig.json ./
COPY src ./src

# Baileys guarda credenciales pareadas en /app/auth. En Railway hay que
# montar ahí un Volume desde la UI (Settings → Volumes → mount path
# /app/auth). El VOLUME directive de Docker no se usa porque Railway lo
# rechaza — usa su propio sistema de volúmenes.

# Puerto del healthcheck HTTP. Railway lo usa para saber si el container
# está vivo. PORT lo inyecta Railway automáticamente; default 8080 si no.
ENV PORT=8080
EXPOSE 8080

# Default command: el daemon. Para hacer el primer pareo, override:
#   railway run -- npm run pair
CMD ["npx", "tsx", "src/daemon.ts"]
