FROM node:22-slim AS builder
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/realtime/ packages/realtime/
RUN corepack enable pnpm && pnpm install --frozen-lockfile --filter @supatype/realtime
RUN pnpm --filter @supatype/realtime build

FROM node:22-slim
WORKDIR /app
COPY --from=builder /build/packages/realtime/dist ./dist
COPY --from=builder /build/packages/realtime/package.json ./
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/packages/realtime/node_modules ./packages_node_modules
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "dist/index.js"]
