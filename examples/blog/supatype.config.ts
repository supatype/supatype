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
  // Served through the deployment rather than beside it.
  //
  // `proxy` puts the Next app at / on the same origin as the API, so a reader reaches the blog and
  // Studio reaches the API through one gateway, and a preview link needs no origin of its own.
  //
  // The host is named explicitly rather than as localhost: the CLI rewrites localhost to
  // host.docker.internal only for a dev-rendered compose, and a self-host stack renders standalone,
  // where localhost is the server container's own loopback and nothing is listening on it.
  app: {
    mode: "proxy",
    upstream: "http://host.docker.internal:3001",
    start: "dev",
  },
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
  // Opted in ahead of the default flip: MinIO's community edition is archived and its batch delete
  // already fails against the last build it published, so this example runs the backend that
  // replaces it.
  storage: { provider: "s3", object_store: "seaweedfs" },
  schema: { path: "schema/index.ts" },
  output: {
    types: "supatype/generated/database.ts",
    client: "supatype/generated/index.d.ts",
  },
  admin: {
    // Where a post renders. A path, not a URL: this deployment serves the app, so Studio resolves
    // it against the origin it is loaded from and there is no origin here to go stale.
    //
    // `{slug}` is filled from the record being edited, so a link points at the address the post's
    // *current* slug implies rather than the one it had when the form loaded.
    livePreview: {
      Post: { urlPattern: "/preview/{slug}" },
    },
  },
})
