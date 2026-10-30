/**
 * The realtime service's process entry: it always starts the server. The image, the release bundle
 * (and the `pkg` binary built from it) and `npm start` run this file; index.ts only exports.
 *
 * index.ts used to start the server only when `process.argv[1]` ended in index.js or index.ts, so a
 * library import would not start one. In the `pkg` binary it is the bundle's snapshot path, so the
 * released binary exited at once with code 0 and no output.
 */
import { loadEnv } from "./env.js"
import { RealtimeServer } from "./server.js"

async function main(): Promise<void> {
  const server = new RealtimeServer(loadEnv())

  const shutdown = async (): Promise<void> => {
    console.log("[realtime] shutting down...")
    await server.stop()
    process.exit(0)
  }

  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())

  await server.start()
}

main().catch((err: unknown) => {
  console.error("[realtime] fatal error:", err)
  process.exit(1)
})
