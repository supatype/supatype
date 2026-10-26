/**
 * How much the service says. `info` (the default) logs what an operator should act on; `debug` adds
 * one line per change withheld from a subscriber by its access rules, which on a busy table is a
 * line per event per subscriber.
 */
export type LogLevel = "debug" | "info"

/** `REALTIME_LOG_LEVEL`, case and surrounding space ignored. Anything else stops the service. */
export function parseLogLevel(raw: string | undefined): LogLevel {
  const value = (raw ?? "").trim().toLowerCase()
  if (value === "" || value === "info") return "info"
  if (value === "debug") return "debug"
  throw new Error(`REALTIME_LOG_LEVEL must be "debug" or "info", got "${raw}"`)
}

/** Environment configuration for the realtime service. */
export interface RealtimeEnv {
  port: number
  databaseUrl: string
  jwtSecret: string
  slotName: string
  /**
   * Publication name, currently read by nothing.
   *
   * `wal2json` decodes from the *slot*; publications are a `pgoutput` concept. The value is kept so a
   * future pgoutput decoder has somewhere to look, and its default matches the empty publication
   * `supatype/postgres` actually creates: it used to default to `supatype_realtime_pub`, a third
   * name that existed nowhere, which is how a decoder would have been written against a publication
   * that was never there.
   */
  publicationName: string
  replicationPollInterval: number
  secureChannels: boolean
  /** `REALTIME_LOG_LEVEL`: see {@link LogLevel}. */
  logLevel: LogLevel

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
    slotName: process.env["SLOT_NAME"] ?? "supatype_realtime",
    publicationName: process.env["PUBLICATION_NAME"] ?? "supatype_realtime",
    replicationPollInterval: Number(process.env["REPLICATION_POLL_INTERVAL"] ?? "100"),
    secureChannels: process.env["SECURE_CHANNELS"] !== "false",
    logLevel: parseLogLevel(process.env["REALTIME_LOG_LEVEL"]),

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
