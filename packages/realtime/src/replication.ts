import pg from "pg"
import type { WalChange, ChangeEvent } from "./types.js"

const { Client } = pg

export interface ReplicationConfig {
  databaseUrl: string
  slotName: string
  pollInterval: number
}

/**
 * Postgres logical replication listener using wal2json.
 *
 * Polls the replication slot at a configurable interval and emits
 * parsed change events via callback.
 */
export class ReplicationListener {
  private config: ReplicationConfig
  private client: pg.Client | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private onChangeCallback: ((change: WalChange) => void) | null = null

  constructor(config: ReplicationConfig) {
    this.config = config
  }

  /** Register the change handler. */
  onChange(callback: (change: WalChange) => void): void {
    this.onChangeCallback = callback
  }

  /** Connect to Postgres and ensure the replication slot exists. */
  async start(): Promise<void> {
    this.client = new Client({ connectionString: this.config.databaseUrl })
    await this.client.connect()

    // Ensure the logical replication slot exists
    await this.ensureSlot()

    this.running = true
    this.timer = setInterval(() => {
      void this.poll()
    }, this.config.pollInterval)

    // Run an initial poll immediately
    void this.poll()
  }

  /** Stop polling and disconnect. */
  async stop(): Promise<void> {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.client) {
      await this.client.end()
      this.client = null
    }
  }

  private async ensureSlot(): Promise<void> {
    if (!this.client) return

    const result = await this.client.query(
      `SELECT 1 FROM pg_replication_slots WHERE slot_name = $1`,
      [this.config.slotName],
    )

    if (result.rows.length === 0) {
      await this.client.query(
        `SELECT pg_create_logical_replication_slot($1, 'wal2json')`,
        [this.config.slotName],
      )
    }
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.client || !this.onChangeCallback) return

    try {
      const result = await this.client.query(
        `SELECT data FROM pg_logical_slot_get_changes($1, NULL, NULL, 'include-timestamp', 'on', 'include-pk', 'on')`,
        [this.config.slotName],
      )

      for (const row of result.rows as Array<{ data: string }>) {
        const changes = this.parseWal2json(row.data)
        for (const change of changes) {
          this.onChangeCallback(change)
        }
      }
    } catch (err) {
      // Log but don't crash — replication errors are recoverable
      console.error("[realtime] replication poll error:", err)
    }
  }

  /**
   * Parse a wal2json output row into WalChange objects.
   * wal2json emits JSON with a `change` array, each entry having
   * kind, schema, table, columnnames, columnvalues, oldkeys, etc.
   */
  private parseWal2json(data: string): WalChange[] {
    try {
      const parsed = JSON.parse(data) as Wal2JsonOutput
      if (!parsed.change) return []

      return parsed.change.map((entry): WalChange => {
        const event = mapKind(entry.kind)
        const newRecord = event !== "DELETE" ? buildRecord(entry.columnnames, entry.columnvalues) : null
        const oldRecord = event !== "INSERT" ? buildRecord(entry.oldkeys?.keynames, entry.oldkeys?.keyvalues) : null

        return {
          schema: entry.schema,
          table: entry.table,
          event,
          newRecord,
          oldRecord,
          commitTimestamp: parsed.timestamp ?? new Date().toISOString(),
        }
      })
    } catch {
      console.error("[realtime] failed to parse wal2json data:", data)
      return []
    }
  }
}

// ─── wal2json types ──────────────────────────────────────────────────────────

interface Wal2JsonOutput {
  timestamp?: string | undefined
  change: Wal2JsonChange[]
}

interface Wal2JsonChange {
  kind: string
  schema: string
  table: string
  columnnames?: string[] | undefined
  columnvalues?: unknown[] | undefined
  oldkeys?: {
    keynames?: string[] | undefined
    keyvalues?: unknown[] | undefined
  } | undefined
}

function mapKind(kind: string): ChangeEvent {
  switch (kind) {
    case "insert": return "INSERT"
    case "update": return "UPDATE"
    case "delete": return "DELETE"
    default: return "INSERT"
  }
}

function buildRecord(names?: string[], values?: unknown[]): Record<string, unknown> | null {
  if (!names || !values) return null
  const record: Record<string, unknown> = {}
  for (let i = 0; i < names.length; i++) {
    record[names[i]!] = values[i]
  }
  return record
}
