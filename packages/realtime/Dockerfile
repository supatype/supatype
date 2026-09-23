FROM node:22-slim AS builder
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/realtime/ packages/realtime/
RUN corepack enable pnpm && pnpm install --frozen-lockfile --filter @supatype/realtime
RUN pnpm --filter @supatype/realtime build

# Production dependencies resolved from the lockfile, by the same package manager that installed
# them above. The runtime stage used to run `npm install --omit=dev` against the package.json
# alone, which re-resolved every dependency from the registry: the image shipped whatever npm
# picked on the day it was built rather than the versions the lockfile pins and the tests ran
# against. `--legacy` is what pnpm 10 calls a deploy without injected workspace dependencies,
# which is this package: it depends on nothing in the workspace.
RUN pnpm --filter @supatype/realtime deploy --legacy --prod /out

FROM node:22-slim
WORKDIR /app
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/package.json ./
COPY --from=builder /out/dist ./dist
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "dist/index.js"]
