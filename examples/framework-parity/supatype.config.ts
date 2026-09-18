import { defineConfig } from "@supatype/cli"

/**
 * One project, three front ends, and only one of them served at a time.
 *
 * `app.mode` is a single setting, so `static_dir` points at whichever app was built last. The three
 * `build:*` scripts each write to their own `dist/<framework>`, and `mode:*` points the server at
 * one of them — see the README.
 */
export default defineConfig({
  project: { name: "framework-parity" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev", port: 54490 },
  app: {
    mode: "static",
    static_dir: "./dist/vue",
  },
  email: { provider: "console" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
  output: {
    types: "supatype/generated/database.ts",
    client: "supatype/generated/index.d.ts",
  },
})
