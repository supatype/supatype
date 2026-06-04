import { defineConfig } from "@supatype/cli"

/** Integration test project; `supatype generate` does not require `connection`. */
export default defineConfig({
  project: { name: "supatype-integration" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev", port: 54399 },
  app: { mode: "none" },
  versions: {
    engine: "0.1.1",
    server: "1.0.5",
    postgres: "17.2",
    deno: "2.2.0",
  },
  schema: { path: "schema/index.ts" },
  output: {
    types: "supatype/generated/database.ts",
    client: "supatype/generated/index.d.ts",
  },
})
