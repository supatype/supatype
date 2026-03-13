FROM node:22-slim AS builder
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/studio/ packages/studio/
COPY packages/client/ packages/client/
RUN corepack enable pnpm && pnpm install --frozen-lockfile --filter @supatype/studio
RUN pnpm --filter @supatype/studio build

FROM nginx:alpine
COPY --from=builder /build/packages/studio/dist /usr/share/nginx/html
COPY --from=builder /build/packages/studio/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3002
CMD ["nginx", "-g", "daemon off;"]
