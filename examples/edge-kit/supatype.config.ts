import { defineConfig } from "@supatype/cli"

/**
 * Edge kit: functions-first manual test / demo.
 *
 * Workflow: `pnpm keys` → `pnpm push` → `pnpm dev`
 * Gateway: Kong on SUPATYPE_KONG_PORT (default 18473).
 * Omit versions so compose uses :latest local images.
 */
export default defineConfig({
  project: { name: "edge-kit" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev", port: 54420 },
  app: {
    mode: "proxy",
    upstream: "http://127.0.0.1:5173",
    start: "vite",
    vite_dev_url: "http://127.0.0.1:5173",
  },
  email: { provider: "console" },
  functions: {
    // write-note writes a row past every access rule, so it has to be named
    // here to see the service-role key. Empty is the default and the point: a
    // function is a public endpoint anyone with the anon key can invoke.
    serviceRole: ["write-note"],
  },
  schema: { path: "schema/index.ts", pg_schema: "public" },
  output: {
    types: "supatype/generated/database.ts",
    client: "supatype/generated/index.d.ts",
  },
})
