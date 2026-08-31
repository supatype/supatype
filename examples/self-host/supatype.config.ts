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
  // No `versions` here on purpose: a pin in a committed example is a pin that
  // goes stale, and these two named a server and an engine that were never
  // published, so the example could not start at all. Pin machine-local
  // component builds in `supatype.local.config.ts` (gitignored) instead.
  email: { provider: "console" },
  storage: { provider: "local", local_path: ".supatype/storage" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
})
