import { defineConfig } from "@supatype/cli"

/**
 * One project, two front ends.
 *
 * `app.mode` is a single value — the server serves one thing at `/` — so the two apps take turns
 * rather than running side by side. That is not a limitation to work around: the mode switch is
 * itself a feature, and `pnpm verify:modes` asserts all three.
 *
 * Day to day, `pnpm dev:app` and `pnpm dev:marketing` write `supatype.local.config.ts`
 * (gitignored, deep-merged) to pick which one you are working on. The committed default is the
 * SPA, because it is the deployment most projects ship.
 */
export default defineConfig({
  project: { name: "kitchen-sink" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev", port: 54480 },
  app: {
    mode: "static",
    static_dir: "./apps/app/dist",
  },
  email: { provider: "console" },
  storage: { provider: "local", local_path: ".supatype/storage" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
  output: {
    types: "supatype/generated/database.ts",
    client: "supatype/generated/index.d.ts",
  },
})
