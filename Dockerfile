# Build the people's page (src/web) with Vite; the server image needs only its output.
FROM node:26-alpine AS web
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.ts ./
COPY src/web ./src/web
RUN npm run build

FROM node:26-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/core ./src/core
COPY src/node ./src/node
COPY --from=web /build/dist/web ./dist/web

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8787/ >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/node/server.ts"]
