import { defineConfig } from "@supatype/cli"

/**
 * Blog example: full project config in one file.
 *
 * `supatype generate` does not need `connection` if you only emit types; set
 * `connection` or `DATABASE_URL` for `push` / `migrate`.
 *
 * Machine-local binary paths: copy `supatype.local.config.ts.example` to
 * `supatype.local.config.ts` (gitignored) and add `overrides` / `versions` there.
 */
export default defineConfig({
  project: { name: "blog" },
  database: { provider: "docker" },
  server: { mode: "dev", port: 54399 },
  app: { mode: "none" },
  // No `versions` here on purpose: a pin in a committed example is a pin that
  // goes stale, and these two named a server and an engine that were never
  // published, so the example could not start at all. Pin machine-local
  // component builds in `supatype.local.config.ts` (gitignored) instead.
  schema: { path: "schema/index.ts" },
  output: {
    types: "supatype/generated/database.ts",
    client: "supatype/generated/index.d.ts",
  },
})
