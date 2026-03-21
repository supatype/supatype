FROM node:22-slim AS builder
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/studio/ packages/studio/
COPY packages/client/ packages/client/
RUN corepack enable pnpm && pnpm install --frozen-lockfile --filter @supatype/studio
RUN pnpm --filter @supatype/client build && pnpm --filter @supatype/studio build

FROM nginx:alpine
RUN echo "worker_processes 1;" > /etc/nginx/nginx.conf.d_worker \
    && sed -i 's/worker_processes.*;/worker_processes 1;/' /etc/nginx/nginx.conf
COPY --from=builder /build/packages/studio/dist /usr/share/nginx/html
COPY --from=builder /build/packages/studio/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3002

# At runtime, write config.js with the cloud config JSON, then start nginx
ENV SUPATYPE_CLOUD_JSON=""
CMD ["/bin/sh", "-c", "printf 'window.__SUPATYPE_CLOUD__ = %s;\\n' \"${SUPATYPE_CLOUD_JSON:-undefined}\" > /usr/share/nginx/html/config.js && nginx -g 'daemon off;'"]
