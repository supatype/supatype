import pg from "pg"
import type { WalChange, ChangeEvent } from "./types.js"
import { isSchemaPushLockHeld } from "./schema-push-lock.js"
import { isTransientConnectionError, withDatabaseRetry } from "./db-retry.js"
import {
  RealtimeUnsupportedError,
  unsupportedRealtimeReason,
  type UnsupportedReason,
} from "./capability.js"

const { Client } = pg

export interface ReplicationConfig {
  databaseUrl: string
  slotName: string
  publicationName?: string | undefined
  pollInterval: number
}

/**
 * Postgres logical replication listener using wal2json.
 *
 * Polls the replication slot at a configurable interval and emits
 * parsed change events via callback.
 *
 * While a schema push holds the shared advisory lock, polls are skipped so
 * WAL decoding does not race DDL (WebSocket server stays up).
 */
export class ReplicationListener {
  private config: ReplicationConfig
  private client: pg.Client | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private stopped = false
  private reconnecting = false
  private unsupported: UnsupportedReason | null = null
  private pollInFlight = false
  private onChangeCallback: ((change: WalChange) => void) | null = null
  private onSchemaChangeCallback: (() => void) | null = null
  private sawSchemaPush = false

  constructor(config: ReplicationConfig) {
    this.config = config
  }

  /** Register the change handler. */
  onChange(callback: (change: WalChange) => void): void {
    this.onChangeCallback = callback
  }

  /** Fired once after a schema push releases the decode lock. */
  onSchemaChange(callback: () => void): void {
    this.onSchemaChangeCallback = callback
  }

  /** True once a connection is established and the slot exists. */
  isConnected(): boolean {
    return this.running && this.client !== null
  }

  /**
   * Why realtime cannot run on this database, or null when it can.
   *
   * Set when slot creation fails for a reason no amount of retrying fixes, `wal_level`, a missing
   * `wal2json`, a role without `REPLICATION`. The service stays up and reports this rather than
   * exiting, because the rest of the stack is unaffected and the operator's database may simply not
   * offer the feature.
   */
  unsupportedReason(): UnsupportedReason | null {
    return this.unsupported
  }

  /**
   * Connect to Postgres and ensure the replication slot exists.
   *
   * The connection is retried while it is unreachable rather than throwing, which used to take the
   * whole process down. The `db` healthcheck made that survivable in a Compose stack; an external
   * database has no container to wait on, and no healthcheck ever covered a database that restarts
   * under a running service. A non-connection failure, a slot that cannot be created because
   * `wal_level` is wrong, say, still propagates, because that is a message the operator needs.
   */
  async start(): Promise<void> {
    this.stopped = false
    await withDatabaseRetry(() => this.connect(), {
      label: "realtime replication",
      shouldContinue: () => !this.stopped,
    })

    this.running = true
    this.timer = setInterval(() => {
      void this.poll()
    }, this.config.pollInterval)

    // Run an initial poll immediately
    void this.poll()
  }

  /**
   * One attempt at a usable connection: connect, then make sure the slot exists.
   *
   * Both halves belong to the same attempt. A connection that succeeds and then drops during slot
   * creation leaves a client that cannot be polled, so the retry has to cover the pair.
   */
  private async connect(): Promise<void> {
    const client = new Client({ connectionString: this.config.databaseUrl })
    client.on("error", (err) => {
      console.error("[realtime] replication connection error:", err)
      this.scheduleReconnect()
    })
    await client.connect()
    this.client = client

    try {
      // The slot, and deliberately not a publication.
      //
      // This used to run `CREATE PUBLICATION … FOR ALL TABLES` first, which **requires superuser**
      //- the strictest privilege anywhere in this service, and one managed Postgres (RDS, Cloud SQL)
      // does not grant. It was the single biggest reason realtime could not run against a database
      // Supatype does not own. And it did nothing: `wal2json` decodes from the *slot*, publications
      // are a `pgoutput` concept, and nothing here consulted `pg_publication` after creating it.
      //
      // Reinstate only alongside a decoder that consumes a publication, and expect to have to answer
      // the superuser question then. `publicationName` stays in the config for that eventuality.
      await this.ensureSlot()
    } catch (err) {
      // Leave no half-open client behind for the next attempt to trip over.
      this.client = null
      await client.end().catch(() => {})

      // A database that cannot do logical decoding is not a transient failure and not a crash
      // either. Record the reason and stop trying; the caller keeps the service up.
      const reason = unsupportedRealtimeReason(err)
      if (reason) {
        this.unsupported = reason
        this.stopped = true
        console.error(
          `[realtime] disabled: ${reason}. Subscriptions are unavailable; the rest of the stack is ` +
            "unaffected. Run `supatype db check` for the remediation, or set " +
            "database.external.realtime: false to stop starting this service.",
        )
        throw new RealtimeUnsupportedError(reason, err)
      }
      throw err
    }
  }

  /**
   * Re-establish a connection that has died under a running service.
   *
   * Without this, a database restart left realtime up and holding WebSocket clients while `poll()`
   * logged the same error every interval forever, subscribers saw silence, not an error, which is
   * the worst of the available outcomes. Idempotent, because both the client's `error` event and the
   * next poll will usually notice the same failure.
   */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnecting) return
    this.reconnecting = true
    this.running = false

    const dead = this.client
    this.client = null

    void (async () => {
      if (dead) await dead.end().catch(() => {})
      try {
        await withDatabaseRetry(() => this.connect(), {
          label: "realtime replication (reconnect)",
          shouldContinue: () => !this.stopped,
        })
        if (!this.stopped) {
          this.running = true
          console.log("[realtime] replication reconnected")
        }
      } catch (err) {
        // A non-transient failure, or a shutdown mid-retry. Either way polling stays off and the
        // readiness probe reports it rather than the service pretending to be subscribed.
        console.error("[realtime] replication could not be re-established:", err)
      } finally {
        this.reconnecting = false
      }
    })()
  }

  /** Stop polling and disconnect. */
  async stop(): Promise<void> {
    this.stopped = true
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
    if (this.pollInFlight) return
    this.pollInFlight = true

    try {
      if (await isSchemaPushLockHeld(this.client)) {
        this.sawSchemaPush = true
        return
      }

      // The lock has just been released, so the push has committed. Field rules are read
      // from security labels and cached, and this is the moment that cache is stale.
      if (this.sawSchemaPush) {
        this.sawSchemaPush = false
        this.onSchemaChangeCallback?.()
      }

      const result = await this.client.query(
        `SELECT data FROM pg_logical_slot_get_changes($1, NULL, NULL, 'include-timestamp', 'on', 'include-pk', 'on')`,
        [this.config.slotName],
      )

      for (const row of result.rows as Array<{ data: string }>) {
        const changes = this.parseWal2json(row.data)
        const onChange = this.onChangeCallback
        if (!onChange) return
        for (const change of changes) {
          onChange(change)
        }
      }
    } catch (err) {
      // Log but don't crash, replication errors are recoverable
      console.error("[realtime] replication poll error:", err)
      // A lost connection is not recoverable by polling it again, which is what used to happen:
      // the same error every interval, forever, while subscribers saw silence.
      if (isTransientConnectionError(err)) this.scheduleReconnect()
    } finally {
      this.pollInFlight = false
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
