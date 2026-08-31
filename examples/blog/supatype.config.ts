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
  // No `server` or `engine` pin here on purpose: the ones that used to be
  // here named supatype/server 0.1.0 and supatype/schema-engine 0.4.2, neither
  // of which was ever published, so this example could not start at all. Pin a
  // machine-local component build in `supatype.local.config.ts` (gitignored).
  //
  // `deno` stays because release-pins.test.ts checks it against the Deno the CLI
  // ships, and `postgres` because that image is published.
  versions: {
    postgres: "17",
    deno: "2.2.0",
  },
  schema: { path: "schema/index.ts" },
  output: {
    types: "supatype/generated/database.ts",
    client: "supatype/generated/index.d.ts",
  },
})
