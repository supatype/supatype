import { defineConfig } from "@supatype/cli"

/**
 * Realtime: a change in the database arriving at a subscriber.
 *
 * Realtime is on by default, so every other example already runs the service.
 * None of them subscribed to anything, which meant the only thing ever proven
 * was that the gateway would upgrade a WebSocket. A socket that opens and never
 * delivers a row looks identical to a working one until someone waits for a
 * message that does not come.
 *
 * `pnpm verify` is that wait, with a deadline: subscribe, insert over REST, and
 * fail if the event does not arrive.
 */
export default defineConfig({
  project: { name: "realtime" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev", port: 54470 },
  // No front end: the subscriber is a script, so a failure is an exit code
  // rather than something a person has to notice in a browser.
  app: { mode: "none" },
  email: { provider: "console" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
  output: {
    types: "supatype/generated/database.ts",
    client: "supatype/generated/index.d.ts",
  },
})
