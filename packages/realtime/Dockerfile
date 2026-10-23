FROM node:22-slim AS builder
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/realtime/ packages/realtime/
# The identifier cutter it shares with the CLI, a run-time dependency built here and copied into
# the deploy below.
COPY packages/shared/ packages/shared/
# The tests' fixtures import @supatype/types, a dev dependency. Nothing from it ships, but pnpm
# resolves every workspace dependency of the package it installs and deploys, so its manifest has to
# be present.
COPY packages/types/package.json packages/types/
RUN corepack enable pnpm && pnpm install --frozen-lockfile --filter "@supatype/realtime..."
RUN pnpm --filter @supatype/shared build && pnpm --filter @supatype/realtime build

# Production dependencies resolved from the lockfile, by the same package manager that installed
# them above. The runtime stage used to run `npm install --omit=dev` against the package.json
# alone, which re-resolved every dependency from the registry: the image shipped whatever npm
# picked on the day it was built rather than the versions the lockfile pins and the tests ran
# against. `--legacy` is what pnpm 10 calls a deploy without injected workspace dependencies,
# which copies `@supatype/shared`, the one workspace package it needs at run time, from its built `dist`.
RUN pnpm --filter @supatype/realtime deploy --legacy --prod /out

FROM node:22-slim
WORKDIR /app
COPY --chmod=0644 packages/realtime/LICENSE /LICENSE
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/package.json ./
COPY --from=builder /out/dist ./dist
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "dist/index.js"]
