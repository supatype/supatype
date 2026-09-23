import { defineConfig } from "@supatype/cli"

/**
 * One project, two front ends.
 *
 * `app.mode` is a single value, the server serves one thing at `/`, so the two apps take turns
 * rather than running side by side. That is not a limitation to work around: the mode switch is
 * itself a feature, and `tests/integration/scripts/kitchen-sink-e2e.sh` asserts all three.
 *
 * Day to day, `pnpm mode:app`, `pnpm mode:marketing` and `pnpm mode:none` pick which one you are
 * working on. Each is a real `supatype app` invocation, so they rewrite this file in place rather
 * than layering a local override; expect a dirty config after switching. The committed default is
 * the SPA, because it is the deployment most projects ship.
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
