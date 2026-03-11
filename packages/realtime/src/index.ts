import { loadEnv } from "./env.js"
import { RealtimeServer } from "./server.js"

export { RealtimeServer } from "./server.js"
export { ChannelManager } from "./channels.js"
export { ReplicationListener } from "./replication.js"
export { RlsFilter } from "./rls.js"
export { verifyToken } from "./auth.js"
export type { JwtClaims } from "./auth.js"
export type { RealtimeEnv } from "./env.js"
export type {
  ChangeEvent,
  WalChange,
  ClientMessage,
  ServerMessage,
  ChangeEventMessage,
  PresenceEventMessage,
  BroadcastEventMessage,
  SystemMessage,
  Subscription,
  PresenceEntry,
} from "./types.js"

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = loadEnv()
  const server = new RealtimeServer(env)

  const shutdown = async () => {
    console.log("[realtime] shutting down...")
    await server.stop()
    process.exit(0)
  }

  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())

  await server.start()
}

// Only run when executed directly (not imported as a library)
const isMainModule = process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts")
if (isMainModule) {
  main().catch((err) => {
    console.error("[realtime] fatal error:", err)
    process.exit(1)
  })
}
