/** Environment configuration for the realtime service. */
export interface RealtimeEnv {
  port: number
  databaseUrl: string
  jwtSecret: string
  slotName: string
  replicationPollInterval: number
  secureChannels: boolean
}

export function loadEnv(): RealtimeEnv {
  const databaseUrl = process.env["DATABASE_URL"]
  if (!databaseUrl) throw new Error("DATABASE_URL is required")

  const jwtSecret = process.env["JWT_SECRET"]
  if (!jwtSecret) throw new Error("JWT_SECRET is required")

  return {
    port: Number(process.env["PORT"] ?? "4000"),
    databaseUrl,
    jwtSecret,
    slotName: process.env["SLOT_NAME"] ?? "realtime_slot",
    replicationPollInterval: Number(process.env["REPLICATION_POLL_INTERVAL"] ?? "100"),
    secureChannels: process.env["SECURE_CHANNELS"] !== "false",
  }
}
