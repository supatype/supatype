import { defineConfig } from "@supatype/cli"

/** Integration test project; `supatype generate` does not require `connection`. */
export default defineConfig({
  project: { name: "supatype-integration" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev", port: 54399 },
  app: { mode: "none" },
  // No `server` or `engine` pin here on purpose: the ones that used to be
  // here named supatype/server 1.0.5 and supatype/schema-engine 0.1.1, and 1.0.5
  // was never published, so anything honouring the pin could not start. Pin a
  // machine-local component build in `supatype.local.config.ts` (gitignored).
  //
  // `deno` stays because release-pins.test.ts checks it against the Deno the CLI
  // ships, and `postgres` because that image is published.
  versions: {
    postgres: "17.2",
    deno: "2.2.0",
  },
  schema: { path: "schema/index.ts" },
  output: {
    types: "supatype/generated/database.ts",
    client: "supatype/generated/index.d.ts",
  },
})
