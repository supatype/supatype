/** Environment configuration for the realtime service. */
export interface RealtimeEnv {
  port: number
  databaseUrl: string
  jwtSecret: string
  slotName: string
  replicationPollInterval: number
  secureChannels: boolean

  // ─── Multi-tenant (cloud mode) ────────────────────────────────────
  /** When true, this instance serves multiple projects on a shared Postgres. */
  multiTenant: boolean
  /**
   * URL of the control plane's routing table API.
   * Used to look up per-project JWT secrets and tier info.
   */
  routingTableUrl?: string | undefined
  /** How often to refresh the routing table cache (ms). */
  routingTableRefreshMs: number
  /**
   * If set, only changes from schemas matching a project ref are forwarded.
   * Internal schemas ({ref}_auth, {ref}_internal) are always filtered out.
   */
  schemaFilterMode: "all" | "developer_only"
  /** Per-tier connection limits. */
  connectionLimits: Record<string, number>
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

    // Multi-tenant settings
    multiTenant: process.env["MULTI_TENANT"] === "true",
    routingTableUrl: process.env["ROUTING_TABLE_URL"],
    routingTableRefreshMs: Number(process.env["ROUTING_TABLE_REFRESH_MS"] ?? "60000"),
    schemaFilterMode: (process.env["SCHEMA_FILTER_MODE"] as "all" | "developer_only") ?? "developer_only",
    connectionLimits: {
      free: Number(process.env["FREE_CONNECTION_LIMIT"] ?? "50"),
      pro: Number(process.env["PRO_CONNECTION_LIMIT"] ?? "500"),
      team: Number(process.env["TEAM_CONNECTION_LIMIT"] ?? "5000"),
      enterprise: Number(process.env["ENTERPRISE_CONNECTION_LIMIT"] ?? "50000"),
    },
  }
}
