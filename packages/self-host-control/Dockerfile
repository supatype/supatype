ARG ENGINE_IMAGE=supatype/schema-engine:latest
FROM ${ENGINE_IMAGE} AS engine

# Built from the repository root: the control plane depends on @supatype/shared, the rules it must
# read the same way as the CLI (the engine's busy wording, its capability cache, the function-name
# rule), so the workspace and its lockfile are needed to build it. Only the sources are copied, so
# a host's node_modules and dist never reach the image.
FROM node:22-bookworm-slim AS builder
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY packages/self-host-control/package.json packages/self-host-control/tsconfig.json packages/self-host-control/
COPY packages/self-host-control/src packages/self-host-control/src
RUN corepack enable pnpm && pnpm install --frozen-lockfile --filter "@supatype/self-host-control..."
RUN pnpm --filter "@supatype/self-host-control..." build
# Production dependencies only, with @supatype/shared copied in rather than linked.
RUN pnpm --filter @supatype/self-host-control deploy --legacy --prod /out

FROM node:22-bookworm-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates libssl3 docker.io && \
    rm -rf /var/lib/apt/lists/*

COPY --chmod=0644 packages/self-host-control/LICENSE /LICENSE
COPY --from=engine /usr/local/bin/supatype-engine /usr/local/bin/supatype-engine

COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/dist ./dist
COPY --from=builder /out/package.json ./

ENV PORT=8080
ENV SUPATYPE_ENGINE_BIN=supatype-engine
EXPOSE 8080
CMD ["node", "dist/server.js"]
