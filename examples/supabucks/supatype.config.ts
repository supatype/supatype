import { defineConfig } from "@supatype/cli"

/**
 * Supabucks — a coffee-shop loyalty app demo.
 *
 * The frontend is a Vite + React SPA built to ./dist and served by Supatype
 * itself (app.mode: "static"). The app and the API share one origin
 * (http://localhost:18473), so there is no CORS and one command runs everything.
 */
export default defineConfig({
  project: { name: "supabucks" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev", port: 54399 },
  app: {
    mode: "static",
    static_dir: "./dist",
  },
  versions: {
    engine: "0.1.1",
    server: "1.0.5",
    postgres: "17.2",
    deno: "2.2.0",
  },
  email: { provider: "console" },
  storage: { provider: "local", local_path: ".supatype/storage" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
  output: { types: "supatype/generated/database.ts" },
})
