import { defineConfig } from "@supatype/cli"

/**
 * The masking matrix's project. `tests/integration/scripts/masking-e2e.sh` brings it up twice:
 * once as it ships on `supatype/postgres` (tier 1, the `supatype_mask` extension), and once with the
 * extension dropped and the schema pushed again (tier 2, the `api` views).
 *
 * Under tier 2 PostgREST has to serve the `api` schema, and the stack starts before any push has
 * decided the tier, so the runner says which tier it is building through MASKING_TIER.
 */
const tier = process.env["MASKING_TIER"] === "2" ? 2 : 1

export default defineConfig({
  project: { name: process.env["MASKING_PROJECT_NAME"] ?? "masking" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev", port: 54480 },
  app: { mode: "none" },
  email: { provider: "console" },
  schema: {
    path: "schema/index.ts",
    pg_schema: "public",
    ...(tier === 2 && { api_schemas: ["api", "supatype", "graphql_public", "auth"] }),
  },
})
