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
  versions: {
    engine: "0.4.2",
    server: "0.1.0",
    postgres: "17",
    deno: "2.2.0",
  },
  schema: { path: "schema/index.ts" },
  output: {
    types: "supatype/generated/database.ts",
    client: "supatype/generated/index.d.ts",
  },
})
