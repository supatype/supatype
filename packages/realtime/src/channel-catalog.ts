import type { ChannelDatabase, Queryable } from "./channel-db.js"
import { tightest, type ChannelMode } from "./channel-access.js"
import { sqlState } from "./drop-log.js"
import { isShape, isString, isOneOf, isUnknown } from "./json.js"
import { parseSendChecks, type ChannelSendChecks } from "./send-checks.js"

/**
 * What the project's database says about channels as a whole, as opposed to one topic: its mode, the
 * content checks of each declaration, and which tables each declaration's rules read.
 *
 * Read at start and after every schema push, the same moments the field-mask catalog is, and shared
 * by every join: a join never reads it again once it is loaded.
 */
export interface ChannelCatalogState {
  /** False when the database has none of the functions: a project pushed by an engine before private channels. */
  supported: boolean
  mode: ChannelMode
  sendChecks: ReadonlyMap<string, ChannelSendChecks>
  /** `schema.table` to the declarations whose rules read it. */
  readers: ReadonlyMap<string, ReadonlySet<string>>
}

/** No functions, so no declarations and nothing to enforce: a project that never opted in. */
const UNSUPPORTED: ChannelCatalogState = {
  supported: false,
  mode: "open",
  sendChecks: new Map(),
  readers: new Map(),
}

const UNDEFINED_FUNCTION = "42883"
const UNDEFINED_SCHEMA = "3F000"

const isModeRow = isShape({ mode: isOneOf(["open", "declared"] as const) })
const isChecksRow = isShape({ channel: isString, checks: isUnknown })
const isDependencyRow = isShape({ channel: isString, table_schema: isString, table_name: isString })

/** `schema.table`, the key readers are held under. */
export function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`
}

async function readMode(q: Queryable): Promise<ChannelMode | null> {
  try {
    const { rows } = await q.query("SELECT _supatype.realtime_channel_mode() AS mode")
    const [row] = rows
    if (!isModeRow(row)) throw new Error("realtime_channel_mode() returned something other than open or declared")
    return row.mode
  } catch (err) {
    // A database with no such function is a project that has not opted in. Any other failure is
    // not an answer, and must not be read as one.
    const state = sqlState(err)
    if (state === UNDEFINED_FUNCTION || state === UNDEFINED_SCHEMA) return null
    throw err
  }
}

async function readSendChecks(q: Queryable): Promise<Map<string, ChannelSendChecks>> {
  const { rows } = await q.query("SELECT channel, checks FROM _supatype.realtime_channel_send_checks()")
  const checks = new Map<string, ChannelSendChecks>()
  for (const row of rows) {
    // A row with no readable channel name cannot be attached to a declaration, so it is skipped. A
    // row whose `checks` cannot be read is not skipped: `parseSendChecks` holds it as unreadable,
    // which refuses every broadcast on that channel.
    if (isChecksRow(row)) checks.set(row.channel, parseSendChecks(row.checks))
  }
  return checks
}

async function readReaders(q: Queryable): Promise<Map<string, Set<string>>> {
  const { rows } = await q.query(
    "SELECT channel, table_schema, table_name FROM _supatype.realtime_channel_dependencies()",
  )
  const readers = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!isDependencyRow(row)) continue
    const key = tableKey(row.table_schema, row.table_name)
    const channels = readers.get(key) ?? new Set<string>()
    channels.add(row.channel)
    readers.set(key, channels)
  }
  return readers
}

async function loadState(db: ChannelDatabase): Promise<ChannelCatalogState> {
  return db.asService(async (q) => {
    const mode = await readMode(q)
    if (mode === null) return UNSUPPORTED
    return { supported: true, mode, sendChecks: await readSendChecks(q), readers: await readReaders(q) }
  })
}

/**
 * The catalog, loaded once and shared.
 *
 * A failed first load is not remembered: the next join asks again, and until one succeeds every join
 * is refused (the guard fails closed). A failed *re*load keeps the state last seen, which was true
 * of the database until the push that is being reloaded for, and is better than nothing; the push
 * itself re-checks every held channel against the database directly.
 */
export class ChannelCatalog {
  private state: ChannelCatalogState | null = null
  private loading: Promise<ChannelCatalogState> | null = null

  constructor(
    private readonly db: ChannelDatabase,
    private readonly envMode: ChannelMode | undefined,
    private readonly onError: (message: string) => void,
  ) {}

  /** The catalog, loading it if it has never been read. Rejects when it cannot be. */
  current(): Promise<ChannelCatalogState> {
    if (this.state !== null) return Promise.resolve(this.state)
    return this.load()
  }

  /** The state last read, or null before the first successful read. Never waits. */
  peek(): ChannelCatalogState | null {
    return this.state
  }

  /** Read it again (after a schema push). A failure keeps what was held. */
  async reload(): Promise<void> {
    try {
      await this.load()
    } catch (err) {
      this.onError(`channel catalog could not be reloaded (SQLSTATE ${sqlState(err)}); keeping the last one read`)
    }
  }

  /** The mode in force: the database's, tightened by `REALTIME_CHANNELS` and never loosened by it. */
  effectiveMode(state: ChannelCatalogState): ChannelMode {
    return tightest(state.mode, this.envMode)
  }

  private load(): Promise<ChannelCatalogState> {
    this.loading ??= loadState(this.db)
      .then((state) => {
        this.state = state
        return state
      })
      .finally(() => {
        this.loading = null
      })
    return this.loading
  }
}
