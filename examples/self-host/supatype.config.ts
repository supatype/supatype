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
  versions: {
    engine: "0.4.2",
    server: "0.1.0",
    postgres: "17.2",
    deno: "2.2.0",
  },
  email: { provider: "console" },
  storage: { provider: "local", local_path: ".supatype/storage" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
})
