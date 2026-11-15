import { defineConfig } from "@supatype/cli"

/**
 * Many-to-many links written through the link (junction) table over the normal API.
 * tests/integration/scripts/m2m-e2e.sh runs this project as a self-hosted stack and drives it.
 */
export default defineConfig({
  project: { name: "m2m" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev", port: 54461 },
  app: { mode: "none" },
  email: { provider: "console" },
  auth: { email: { enableConfirmations: false } },
  schema: { path: "schema/index.ts", pg_schema: "public" },
  output: {
    types: "supatype/generated/database.ts",
    client: "supatype/generated/index.d.ts",
  },
})
