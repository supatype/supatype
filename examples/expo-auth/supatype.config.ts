import { defineConfig } from "@supatype/cli"

/**
 * Expo auth example — full Supatype project (schema + local docker stack).
 *
 * Workflow: `supatype keys` → `supatype push` → `supatype dev` → `pnpm start`
 * API gateway: Kong on SUPATYPE_KONG_PORT (default 18473).
 *
 * Machine-local binary paths: copy `supatype.local.config.ts.example` →
 * `supatype.local.config.ts` (gitignored).
 */
export default defineConfig({
  project: { name: "expo-auth" },
  database: { provider: "docker" },
  server: { mode: "dev", port: 54410 },
  app: { mode: "none" },
  email: { provider: "console" },
  // Omit versions so compose uses :latest (local images: server/postgres/etc.).
  schema: { path: "schema/index.ts", pg_schema: "public" },
  output: {
    types: "supatype/generated/database.ts",
    client: "supatype/generated/index.d.ts",
  },
})
