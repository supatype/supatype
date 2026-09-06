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
    // The publishing layer needs 0.3.0+. Point at a local build with `supatype.local.config.ts`
    // until it is released; see `supatype.local.config.ts.example`.
    engine: "0.3.0",
    server: "2.0.1",
    postgres: "17",
    deno: "2.2.0",
  },
  schema: { path: "schema/index.ts" },
  output: {
    types: "supatype/generated/database.ts",
    client: "supatype/generated/index.d.ts",
  },
  admin: {
    // Where a post renders, so Studio can build a preview link that opens somewhere.
    //
    // Without this Studio has no address to attach a code to, and says so rather than handing over
    // the bare credential. `{slug}` is filled from the record being edited, so a link points at the
    // address the post's *current* slug implies rather than the one it had when the form loaded.
    livePreview: {
      Post: {
        url: "http://localhost:3000",
        urlPattern: "http://localhost:3000/preview/{slug}",
      },
    },
  },
})
