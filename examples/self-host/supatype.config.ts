import { defineConfig } from "@supatype/cli"

export default defineConfig({
  project: { name: "self-host-example" },
  database: {
    provider: "docker",
  },
  server: {
    mode: "standalone",
    port: 54321,
  },
  app: {
    mode: "proxy",
    upstream: "http://host.docker.internal:3000",
  },
  // No `server` or `engine` pin here on purpose: the ones that used to be
  // here named supatype/server 0.1.0 and supatype/schema-engine 0.4.2, neither
  // of which was ever published, so this example could not start at all. Pin a
  // machine-local component build in `supatype.local.config.ts` (gitignored).
  //
  // `deno` stays because release-pins.test.ts checks it against the Deno the CLI
  // ships, and `postgres` because that image is published.
  versions: {
    postgres: "17.2",
    deno: "2.2.0",
  },
  email: { provider: "console" },
  storage: { provider: "local", local_path: ".supatype/storage" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
})
