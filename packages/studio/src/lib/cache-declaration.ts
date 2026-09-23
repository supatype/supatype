/**
 * The ceiling, as a screen has to render it.
 *
 *   The model declares what is PERMITTED. Studio and the admin API decide what is ACTIVE,
 *   and may only narrow it. (plan §13.2)
 *
 * The server enforces that on both the write path and the read path, so Studio cannot widen
 * anything by getting this wrong. What it can do is refuse to explain itself: a checkbox that
 * unticks itself after a save, or one that is simply disabled, has told the operator nothing and
 * they will try again. Every refusal here comes with the sentence that names the line of schema
 * that would change it.
 *
 * `declared` absent is "nothing is permitted", not "no constraint" — the same direction the server
 * takes for a manifest written before the field existed. An old server omits the key entirely, and
 * reading that as permission would show a project a set of controls its own server would refuse.
 */

/** What the schema permits for one table, as `GET /admin/v1/config/rest` reports it. */
export interface TableDeclaration {
  enabled?: boolean
  maxTtl?: number
  public?: boolean
  rows?: boolean
}

export type DeclaredCache = Record<string, TableDeclaration>

/** What Studio may offer for one table, and what to say wherever it may not. */
export interface TableControls {
  /** Whether the response cache may be turned on at all. */
  canEnable: boolean
  /** Whether one entry may be shared across callers. */
  canAllowPublic: boolean
  /** The highest TTL the schema permits for this table, or null when it declared no cap. */
  ttlCeiling: number | null
  /** Why a control is unavailable, per control. Absent where the control is offered. */
  reason: { enable?: string; allowPublic?: string; ttl?: string }
}

/** The schema line that turns a table's response cache on, quoted the way a user would type it. */
const ENABLE_SNIPPET = "cache: { enabled: true }"

/**
 * What Studio may offer for one table.
 *
 * Deliberately not "is this table cached" — that is the runtime allowlist, which lives beside this
 * and is what the checkboxes hold. This answers the prior question of which checkboxes may be
 * moved at all.
 */
export function controlsFor(declared: DeclaredCache | undefined, table: string): TableControls {
  const entry = declared?.[table]

  if (!entry) {
    return {
      canEnable: false,
      canAllowPublic: false,
      ttlCeiling: null,
      reason: {
        enable:
          `Your schema declares no cache for ${table}, so nothing may cache it. ` +
          `Add \`${ENABLE_SNIPPET}\` to the model and run \`supatype push\`.`,
      },
    }
  }

  if (entry.enabled === false) {
    // A hard opt-out, and the one refusal that is not a missing line but a present one. Saying
    // "add a declaration" here would send someone looking for something that is already there.
    return {
      canEnable: false,
      canAllowPublic: false,
      ttlCeiling: ttlCeilingOf(entry),
      reason: {
        enable:
          `Your schema sets \`cache: { enabled: false }\` on ${table}. That is an opt-out a ` +
          `runtime edit cannot override — change it in the model and push.`,
      },
    }
  }

  const reason: TableControls["reason"] = {}
  if (entry.public !== true) {
    reason.allowPublic =
      `Your schema does not permit a shared cache key for ${table}, so entries stay per-user. ` +
      `A shared entry is served to every caller, so \`push\` refuses it on a table whose read ` +
      `rule varies by caller.`
  }
  const ttlCeiling = ttlCeilingOf(entry)
  if (ttlCeiling !== null) {
    reason.ttl = `Your schema caps ${table} at ${ttlCeiling}s, whatever this is set to.`
  }

  return { canEnable: true, canAllowPublic: entry.public === true, ttlCeiling, reason }
}

/**
 * A declared cap, or null.
 *
 * Zero is not a cap of zero seconds — which would be a declaration that permits caching and then
 * forbids every entry — it is the absence of one. The server's `Permitted.MaxTTL` reads it the
 * same way, and a screen that showed "capped at 0s" would be describing a state that cannot exist.
 */
function ttlCeilingOf(entry: TableDeclaration): number | null {
  const ttl = entry.maxTtl
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) return null
  return ttl
}

/**
 * The cap the project-wide TTL is held to: the *highest* declared per-table cap, or null when no
 * table declares one.
 *
 * The highest and not the lowest, mirroring the server: `cache_max_ttl` is one number for the
 * whole project, so taking the lowest would let one model with a five-second cap drag every other
 * table down to five seconds — narrowing nobody asked for. The per-table cap is applied per table,
 * on the read path, where the table being served is known.
 */
export function projectTtlCeiling(declared: DeclaredCache | undefined): number | null {
  let highest: number | null = null
  for (const entry of Object.values(declared ?? {})) {
    const ttl = ttlCeilingOf(entry)
    if (ttl !== null && (highest === null || ttl > highest)) highest = ttl
  }
  return highest
}

/** A table whose schema declares caching, whether or not the runtime has it switched on. */
export function declaredTables(declared: DeclaredCache | undefined): string[] {
  return Object.keys(declared ?? {})
    .filter((t) => declared?.[t]?.enabled !== false)
    .sort()
}

/* ─── Mode B: shown, never offered ─────────────────────────────────────────── */

/**
 * What to say about the row cache for one table.
 *
 * **There is no toggle here, on purpose.** The row cache is eventual with a bound rather than
 * read-your-writes: a cross-session `UPDATE` then `SELECT` can return the previous row for up to
 * the staleness window. Whether a table tolerates that is a design-time invariant its author knows
 * and an operator flipping a switch at 3am does not, so Mode A gets a runtime switch and Mode B
 * does not (§13.3). Studio shows its state and points at the schema.
 *
 * Which means this line is never silent, including for a table that declares nothing: the reason
 * there is no switch to find is the thing worth saying, and a blank space where a control might
 * have been says it to nobody.
 */
export interface RowCacheLine {
  tone: "good" | "warn" | "neutral"
  text: string
}

/** The live row-cache state this line needs. A subset of RowCacheStatus, so a caller may pass it. */
export interface RowCacheLiveState {
  state: "unavailable" | "off" | "idle" | "participating" | "incoherent"
  stale_after_ms: number
}

export function rowCacheLine(
  declared: DeclaredCache | undefined,
  table: string,
  live: RowCacheLiveState | null,
  staleness: (ms: number) => string,
  /**
   * Why the status could not be read, when it could not.
   *
   * Absent status and failed status are different answers and were rendered as the same one. The
   * row-cache endpoint answered 502 for a while on every database where the feature was actually
   * on, and the panel reported that as "the row cache is not running" — the exact words it uses
   * for a database where it is off, on the one database where it was working.
   */
  readError?: string | null,
): RowCacheLine {
  if (declared?.[table]?.rows !== true) {
    return {
      tone: "neutral",
      text:
        `Primary-key reads for ${table} come from the heap. In-memory row caching is a schema ` +
        `decision rather than a switch — add \`cache: { rows: true }\` to the model and push — ` +
        `because a cached row read can return the previous row for a moment after someone else ` +
        `writes it, and only the model's author knows whether that is acceptable.`,
    }
  }

  // Declared, so the rest is about whether it is actually happening — which is not the same
  // question, and a screen that answered only the first would report a stalled cache as a working
  // one on the strength of a line of schema.
  if (!live && readError) {
    return {
      tone: "warn",
      text:
        `Your schema declares \`cache: { rows: true }\` for ${table}, but this screen could not ` +
        `read the row cache's status: ${readError}. That is a fault in the status endpoint, not a ` +
        `statement about the cache — it may well be running. Check the server logs rather than ` +
        `the schema.`,
    }
  }

  if (!live || live.state === "unavailable" || live.state === "off") {
    return {
      tone: "warn",
      text:
        `Your schema declares \`cache: { rows: true }\` for ${table}, but the row cache is not ` +
        `running on this database — these reads come from the heap. On Cloud it runs on paid ` +
        `plans; self-host needs pg_keyspace with \`rowcache_decode\` and \`rowcache_readthrough\` on.`,
    }
  }
  // Running, but nothing registered. The registration follows an affirmative write to the
  // allowlist rather than a startup reconcile — a reconcile at startup would read an empty
  // allowlist on a fresh pod and unregister everything — so a push that adds `rows: true` leaves
  // the table declared and not yet registered. That is a specific thing to do, and "serving" and
  // "off" are both the wrong thing to say about it.
  if (live.state === "idle") {
    return {
      tone: "neutral",
      text:
        `Your schema declares \`cache: { rows: true }\` for ${table}. The row cache is running ` +
        `but has no tables registered yet — saving the cache settings above registers it. ` +
        staleness(live.stale_after_ms),
    }
  }
  if (live.state === "incoherent") {
    return {
      tone: "warn",
      text:
        `Your schema declares \`cache: { rows: true }\` for ${table}, and the row cache has ` +
        `stopped serving because invalidations are not arriving in time. Reads are still correct; ` +
        `they are no longer faster.`,
    }
  }
  return {
    tone: "good",
    text:
      `Declared in your schema: primary-key reads for ${table} are served from memory. ` +
      staleness(live.stale_after_ms),
  }
}
