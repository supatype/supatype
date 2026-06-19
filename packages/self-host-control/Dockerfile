ARG ENGINE_IMAGE=supatype/schema-engine:latest
FROM ${ENGINE_IMAGE} AS engine

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install && npm run build

FROM node:22-bookworm-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates libssl3 docker.io && \
    rm -rf /var/lib/apt/lists/*

COPY --from=engine /usr/local/bin/supatype-engine /usr/local/bin/supatype-engine

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

ENV PORT=8080
ENV SUPATYPE_ENGINE_BIN=supatype-engine
EXPOSE 8080
CMD ["node", "dist/server.js"]
