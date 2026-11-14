import type { ChannelDatabase, Queryable } from "../../src/channel-db.js"
import type { JwtClaims } from "../../src/auth.js"
import { isJsonObject } from "../../src/json.js"

/**
 * An in-memory stand-in for the database side of private channels: the four functions of the
 * build contract (14.2), answering for the plan's LotChannel and Lobby examples, as the SQL in
 * `channel-functions.sql` does against a real Postgres.
 *
 * It exists so the server's behaviour (what it asks, how often, and what it does with the answer)
 * can be tested without a database, and so every query is counted: "one database call per join and
 * none per broadcast" is a claim about this object's counters.
 */

export const LOT_ID = "8f14e45f-ceea-467a-9575-8b0e4a1b2c3d"
export const OTHER_LOT_ID = "1679091c-5a88-4faf-b5d3-1b7e6f0a9c11"

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
const LOT_TOPIC = new RegExp(`^lot:(${UUID})$`)
const LOT_PREFIX = /^lot:[^:]+$/

/** A row of `realtime_channel_access`. */
interface AccessRow {
  channel: string
  fits: boolean
  can_join: boolean
  can_send: boolean
  can_track: boolean
}

export type ChannelsMode = "open" | "declared"

/** What the fake database does to the next sessions it is asked for. */
export type Fault = Error | null

export class FakeChannelDb implements ChannelDatabase {
  /** Lot id to the users watching it (the `lot_watchers` table). */
  readonly watchers = new Map<string, Set<string>>()
  /** Lot id to the seller (the `lots` table). */
  readonly sellers = new Map<string, string>()
  mode: ChannelsMode = "declared"
  /** When set, every session fails with it, as a pool that cannot reach the database does. */
  fault: Fault = null
  /** The `checks` of LotChannel's send rule, as `realtime_channel_send_checks()` returns it. */
  sendChecks: unknown = {
    type: "all",
    rules: [
      { type: "event", name: "bid" },
      { type: "payload", field: "amount", check: { kind: "number", min: 1 } },
    ],
  }
  /** Sessions opened as a caller: one per join, one per socket per re-check. */
  callerSessions = 0
  /** Sessions opened as the service, for the catalog. */
  serviceSessions = 0
  /** Every access question asked, with who asked it. */
  readonly accessCalls: Array<{ topic: string; sub: string | undefined; role: string | undefined }> = []
  /** Every statement of every session. */
  queries = 0
  /** When true, a rule that reads `lot_watchers` raises `insufficient_privilege` for the anon role, as it does in Postgres. */
  anonLacksPrivilege = false
  /** When true the four functions do not exist, as on a project pushed by an engine before them. */
  noFunctions = false

  watch(lot: string, user: string): void {
    const set = this.watchers.get(lot) ?? new Set<string>()
    set.add(user)
    this.watchers.set(lot, set)
  }

  unwatch(lot: string, user: string): void {
    this.watchers.get(lot)?.delete(user)
  }

  async asCaller<T>(claims: JwtClaims, run: (q: Queryable) => Promise<T>): Promise<T> {
    this.callerSessions++
    if (this.fault !== null) throw this.fault
    return run(this.queryable(claims))
  }

  async asService<T>(run: (q: Queryable) => Promise<T>): Promise<T> {
    this.serviceSessions++
    if (this.fault !== null) throw this.fault
    return run(this.queryable(null))
  }

  private queryable(claims: JwtClaims | null): Queryable {
    return {
      query: async (sql, params) => {
        this.queries++
        if (this.noFunctions) throw Object.assign(new Error("function does not exist"), { code: "42883" })
        return { rows: this.answer(sql, params ?? [], claims) }
      },
    }
  }

  private answer(sql: string, params: readonly unknown[], claims: JwtClaims | null): unknown[] {
    if (sql.includes("SAVEPOINT")) return []
    if (sql.includes("realtime_channel_mode")) return [{ mode: this.mode }]
    if (sql.includes("realtime_channel_send_checks")) {
      return [{ channel: "LotChannel", checks: this.sendChecks }, { channel: "Lobby", checks: null }]
    }
    if (sql.includes("realtime_channel_dependencies")) {
      return [
        { channel: "LotChannel", table_schema: "public", table_name: "lot_watchers" },
        { channel: "LotChannel", table_schema: "public", table_name: "lots" },
      ]
    }
    if (sql.includes("realtime_channel_access")) {
      const topic = String(params[0])
      this.accessCalls.push({ topic, sub: claims?.sub, role: claims?.role })
      return this.access(topic, claims)
    }
    throw new Error(`the fake database was asked something it does not know: ${sql}`)
  }

  private access(topic: string, claims: JwtClaims | null): AccessRow[] {
    if (topic === "lobby") {
      const signedIn = claims?.role === "authenticated"
      return [{ channel: "Lobby", fits: true, can_join: signedIn, can_send: signedIn, can_track: signedIn }]
    }
    const match = LOT_TOPIC.exec(topic)
    if (match === null) {
      return LOT_PREFIX.test(topic)
        ? [{ channel: "LotChannel", fits: false, can_join: false, can_send: false, can_track: false }]
        : []
    }
    return [this.lotRow(match[1] ?? "", claims)]
  }

  private lotRow(lot: string, claims: JwtClaims | null): AccessRow {
    if (this.anonLacksPrivilege && claims?.role === "anon") {
      throw Object.assign(new Error("permission denied for table lot_watchers"), { code: "42501" })
    }
    const user = claims?.sub
    const metadata = claims?.["app_metadata"]
    const auctioneer = isJsonObject(metadata) && metadata["role"] === "auctioneer"
    const watching = user !== undefined && this.watchers.get(lot)?.has(user) === true
    const selling = user !== undefined && this.sellers.get(lot) === user
    return {
      channel: "LotChannel",
      fits: true,
      can_join: watching || auctioneer,
      can_send: selling || auctioneer,
      can_track: watching,
    }
  }
}

/** A database that answers every question with "nothing declared": what the suites that predate private channels run on. */
export function undeclaredChannels(): FakeChannelDb {
  const db = new FakeChannelDb()
  db.mode = "open"
  db.noFunctions = true
  return db
}
