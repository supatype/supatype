import type pg from "pg"
import { TtlCache } from "./ttl-cache.js"
import { isJsonObject } from "./json.js"
import { fieldReadPredicateName, rowReadPredicateName } from "./predicate-names.js"
import type { TableCatalog } from "./table-catalog.js"

/**
 * Per-column masking for realtime payloads.
 *
 * Logical decoding does not plan a query, so nothing the `supatype_mask` extension does
 * reaches a WAL record, a column masked for a caller over REST would otherwise arrive
 * in full over the socket. Realtime has to apply the same rules itself.
 *
 * It does so from the same source of truth as the API: the engine-generated
 * `can_read_<table>__<column>` predicates. Under tier 1 the security labels the engine writes
 * name them, and the predicate a subscriber is judged by is the exact function the planner
 * rewrite calls. Under tier 2 there are no labels; the engine records which predicate decides each
 * column in `_supatype.schema_state` instead, and only a database last pushed by an engine before
 * 0.7.0, which records nothing, leaves realtime to find them by name.
 */

/**
 * How the database enforces field rules, as the engine recorded at its last push.
 *
 * - `extension` (tier 1): `supatype_mask` and security labels. The API roles hold privileges on
 *   the model tables, so a row can be re-selected as the subscriber. Also what a database the
 *   engine records no field rules for is treated as, since nothing changes its grants.
 * - `views` (tier 2): the `api` views. The API roles hold nothing on the model tables, so every
 *   verdict has to come from the generated predicates applied to the WAL record.
 */
export type MaskingTier = "extension" | "views"

/**
 * The tiers the engine records (`_supatype.schema_state`) that mean "the API roles were given the
 * views, not the tables". `broken` is tier 2 whose views did not materialise: still no base access.
 */
const VIEW_TIERS = new Set(["views", "broken"])

/**
 * A generated predicate that could not be tied to exactly one column. Its message names the
 * function, never a value from a row, so it is safe to log.
 */
export class CatalogMismatch extends Error {}

/** The provider whose labels describe field access. Matches `supatype_mask`. */
const MASK_PROVIDER = "supatype"

/** Every boolean `can_read_*` function of the table's schema taking exactly the table's row type. */
const READ_PREDICATES_SQL = `
  SELECT p.proname AS name
    FROM pg_proc p
    JOIN pg_class c ON c.oid = to_regclass(format('%I.%I', $1::text, $2::text))
   WHERE p.pronamespace = c.relnamespace
     AND p.pronargs = 1
     AND p.proargtypes[0] = c.reltype
     AND p.prorettype = 'boolean'::regtype
     AND starts_with(p.proname, 'can_read_')`

export interface PredicateRef {
  schema?: string
  name: string
}

/**
 * Split `public."can_read_posts__salary"` into its parts.
 *
 * The parts are re-quoted by {@link quotePredicateRef} before they reach SQL, never
 * interpolated as given. A label is written by whoever owns the table, so treating its
 * contents as trusted SQL would make `SECURITY LABEL` an injection vector into a
 * connection that runs with the subscriber's role.
 */
export function parsePredicateRef(raw: string): PredicateRef | null {
  const parts: string[] = []
  let index = 0

  while (index < raw.length) {
    if (raw[index] === '"') {
      let value = ""
      index++
      for (;;) {
        if (index >= raw.length) return null // unterminated quote
        if (raw[index] === '"') {
          if (raw[index + 1] === '"') {
            value += '"'
            index += 2
            continue
          }
          index++
          break
        }
        value += raw[index]
        index++
      }
      parts.push(value)
    } else {
      const end = raw.indexOf(".", index)
      const value = end === -1 ? raw.slice(index) : raw.slice(index, end)
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) return null
      parts.push(value)
      index = end === -1 ? raw.length : end
    }

    if (index < raw.length) {
      if (raw[index] !== ".") return null
      index++
      if (index >= raw.length) return null // trailing dot
    }
  }

  if (parts.length === 1) return { name: parts[0]! }
  if (parts.length === 2) return { schema: parts[0]!, name: parts[1]! }
  return null
}

export function quotePredicateRef(ref: PredicateRef): string {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`
  return ref.schema ? `${quote(ref.schema)}.${quote(ref.name)}` : quote(ref.name)
}

export interface MaskLabel {
  read?: PredicateRef
  write?: PredicateRef
}

/** `MASK READ <fn> [WRITE <fn>]`, in either order, keywords case-insensitive. */
export function parseMaskLabel(label: string): MaskLabel | null {
  const tokens = label.trim().split(/\s+/)
  if (tokens.length === 0 || tokens[0]!.toUpperCase() !== "MASK") return null

  const parsed: MaskLabel = {}

  for (let index = 1; index < tokens.length; index += 2) {
    const keyword = tokens[index]!.toUpperCase()
    const value = tokens[index + 1]
    if (value === undefined) return null

    const ref = parsePredicateRef(value)
    if (!ref) return null

    if (keyword === "READ") parsed.read = ref
    else if (keyword === "WRITE") parsed.write = ref
    else return null
  }

  return parsed
}

/**
 * Column → the predicate that decides whether a subscriber may read it.
 *
 * `null` means mask unconditionally: the label exists but could not be understood, so the
 * column cannot be judged and must not be broadcast. Same fail-closed direction the
 * extension takes on the read path.
 */
export type ReadMasks = Map<string, PredicateRef | null>

/**
 * One entry of `capabilities.fieldMasking.columns` in `_supatype.schema_state`, which the engine
 * writes at every push from 0.7.0: the predicates that decide one column, named as a label names
 * them (`public."can_read_<t>__<col>"`). Only `read` matters here.
 */
export interface RecordedFieldPredicate {
  table: string
  column: string
  read?: string | null
}

function isRecordedFieldPredicate(entry: unknown): entry is RecordedFieldPredicate {
  if (!isJsonObject(entry)) return false
  const { table, column, read } = entry
  const readIsNameOrAbsent = read === null || read === undefined || typeof read === "string"
  return typeof table === "string" && typeof column === "string" && readIsNameOrAbsent
}

/**
 * The recorded mapping, checked. `null` when there is none, from an engine before 0.7.0. One that
 * is there but not in this shape cannot be trusted to name every masked column, so it fails closed.
 */
export function parseRecordedColumns(raw: unknown): RecordedFieldPredicate[] | null {
  if (raw == null) return null
  if (!Array.isArray(raw) || !raw.every(isRecordedFieldPredicate)) {
    throw new CatalogMismatch("the recorded field predicate mapping is not in a shape realtime reads")
  }
  return raw
}

/**
 * One table's read masks from the recorded mapping. Entries whose predicate lives in another
 * schema belong to a same-named table there. A predicate that does not parse masks its column
 * unconditionally, as an unparseable label does.
 */
export function recordedReadMasks(
  columns: readonly RecordedFieldPredicate[],
  schema: string,
  table: string,
): ReadMasks {
  const masks: ReadMasks = new Map()
  for (const entry of columns) {
    if (entry.table !== table || entry.read == null) continue
    const ref = parsePredicateRef(entry.read)
    if (ref?.schema !== undefined && ref.schema !== schema) continue
    masks.set(entry.column, ref && { schema, name: ref.name })
  }
  return masks
}

/** What the engine recorded at its last push: the tier, and under tier 2 the mapping if it wrote one. */
interface RecordedMasking {
  tier: MaskingTier
  columns: RecordedFieldPredicate[] | null
}

const RECORDED_MASKING_SQL = `
  SELECT capabilities->'fieldMasking'->>'tier' AS tier,
         capabilities->'fieldMasking'->'columns' AS columns
    FROM _supatype.schema_state`

/**
 * Which columns of which tables carry a read restriction, cached.
 *
 * Read on its own connection, deliberately: the catalog lookup must not happen inside the
 * transaction that has already switched to the subscriber's role.
 *
 * Invalidated on a schema push (the replication listener sees the advisory lock released),
 * with a TTL as a backstop for a push that happened while this process was not watching.
 * The TTL bounds how long a newly-restricted column could still be broadcast.
 */
export class FieldMaskCatalog {
  private cache: TtlCache<ReadMasks>
  private recorded: TtlCache<RecordedMasking>
  /** Tables already reported as masked by the naming rule, so each is reported once. */
  private guessed = new Set<string>()

  constructor(
    private pool: pg.Pool,
    private tables: TableCatalog,
    ttlMs = 30_000,
  ) {
    this.cache = new TtlCache(ttlMs)
    this.recorded = new TtlCache(ttlMs)
  }

  invalidate(): void {
    this.cache.clear()
    this.recorded.clear()
  }

  /**
   * The database's masking tier. One answer for the whole database: the engine decides it per
   * push, from whether `supatype_mask` is installed, and grants every model table accordingly.
   */
  async tier(): Promise<MaskingTier> {
    return (await this.recordedMasking()).tier
  }

  /**
   * The read-restricted columns of a table and the predicate each is judged by. Callers only see
   * `ReadMasks`; where they come from is {@link loadMasks}.
   */
  async readMasks(schema: string, table: string): Promise<ReadMasks> {
    const recorded = await this.recordedMasking()
    return this.cache.get(`${recorded.tier}:${schema}.${table}`, () =>
      this.loadMasks(recorded, schema, table),
    )
  }

  private recordedMasking(): Promise<RecordedMasking> {
    return this.recorded.get("", () => this.loadRecorded())
  }

  /**
   * Tier 1 reads the security labels, which are what `supatype_mask` enforces on the API. Tier 2
   * reads the mapping the engine recorded, and rebuilds names by the naming rule only when the
   * engine that last pushed recorded none.
   */
  private async loadMasks(recorded: RecordedMasking, schema: string, table: string): Promise<ReadMasks> {
    if (recorded.tier === "extension") return this.loadFromLabels(schema, table)
    if (recorded.columns) return recordedReadMasks(recorded.columns, schema, table)
    this.reportGuess(schema, table)
    return this.loadFromPredicates(schema, table)
  }

  private reportGuess(schema: string, table: string): void {
    const key = `${schema}.${table}`
    if (this.guessed.has(key)) return
    this.guessed.add(key)
    console.warn(
      `[realtime] ${key}: the engine that last pushed recorded no field predicate mapping (engines ` +
        `before 0.7.0), so its field predicates are matched to columns by the naming rule, and a ` +
        `predicate the engine had to number withholds the table's changes`,
    )
  }

  private async loadRecorded(): Promise<RecordedMasking> {
    const state = await this.pool.query<{ recorded: boolean }>(
      `SELECT to_regclass('_supatype.schema_state') IS NOT NULL AS recorded`,
    )
    // No engine state at all: nothing revoked the tables, so the tier-1 path is the one that works.
    if (state.rows[0]?.recorded !== true) return { tier: "extension", columns: null }
    const result = await this.pool.query<{ tier: string | null; columns: unknown }>(RECORDED_MASKING_SQL)
    const row = result.rows[0]
    // Tier 1 reads labels, so a mapping it has no use for is not allowed to fail it.
    return VIEW_TIERS.has(row?.tier ?? "")
      ? { tier: "views", columns: parseRecordedColumns(row?.columns) }
      : { tier: "extension", columns: null }
  }

  /**
   * Tier 2's mask list by the naming rule: every column with a generated
   * `can_read_<table>__<column>(<table>)`. The fallback for a database last pushed by an engine
   * before 0.7.0, which records no mapping.
   *
   * Looked up in the table's own schema, taking the table's row type, returning boolean: the
   * signature the engine emits, so a same-named function elsewhere is never picked up. A field
   * predicate that cannot be tied to exactly one column (one the engine numbered because two
   * columns' names clip to the same 63 bytes) stops the table (fail closed) rather than leaving a
   * restricted column unmasked.
   */
  private async loadFromPredicates(schema: string, table: string): Promise<ReadMasks> {
    const [shape, predicates] = await Promise.all([
      this.tables.shape(schema, table),
      this.pool.query<{ name: string }>(READ_PREDICATES_SQL, [schema, table]),
    ])
    const claimants = new Map<string, string[]>()
    for (const column of shape.columns) {
      const name = fieldReadPredicateName(table, column)
      const owners = claimants.get(name)
      if (owners) owners.push(column)
      else claimants.set(name, [column])
    }

    const masks: ReadMasks = new Map()
    const rowPredicate = rowReadPredicateName(table)
    for (const { name } of predicates.rows) {
      if (name === rowPredicate) continue
      const owners = claimants.get(name) ?? []
      if (owners.length !== 1) {
        throw new CatalogMismatch(`field predicate ${name} matches ${owners.length} columns of ${table}`)
      }
      masks.set(owners[0]!, { schema, name })
    }
    return masks
  }

  private async loadFromLabels(schema: string, table: string): Promise<ReadMasks> {
    const masks: ReadMasks = new Map()
    const result = await this.pool.query<{ column_name: string; label: string }>(
      `SELECT a.attname AS column_name, l.label
         FROM pg_seclabel l
         JOIN pg_class c ON c.oid = l.objoid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = l.objoid AND a.attnum = l.objsubid
        WHERE l.provider = $1
          AND l.classoid = 'pg_class'::regclass
          AND n.nspname = $2
          AND c.relname = $3`,
      [MASK_PROVIDER, schema, table],
    )

    for (const row of result.rows) {
      const parsed = parseMaskLabel(row.label)
      if (!parsed) {
        masks.set(row.column_name, null)
        continue
      }
      // No read restriction: a WRITE-only rule leaves reads alone.
      if (parsed.read) masks.set(row.column_name, parsed.read)
    }

    return masks
  }
}

/**
 * Whether a subscriber's column filter can be evaluated against the raw record.
 *
 * It cannot if it names a column they may not read: "did I receive this event" would then
 * answer a question about a value they are not allowed to see, and a handful of
 * subscriptions would binary-search it. Same oracle the extension closes in a `WHERE`
 * clause, one layer up.
 *
 * `*` is the catalog's "unknown", which makes every filter unsafe, a round trip rather
 * than a disclosure.
 */
export function filterIsMaskSafe(
  filter: Record<string, string>,
  masked: Set<string>,
): boolean {
  if (masked.size === 0) return true
  if (masked.has("*")) return false
  return Object.keys(filter).every((column) => !masked.has(column))
}

/**
 * Null every column the subscriber may not read.
 *
 * A verdict that is not exactly `true` masks: a predicate returning NULL, a column the
 * verdict query never answered for, and an unparseable label all mean "unknown", and
 * unknown must not resolve to disclosure.
 *
 * A column absent from the record stays absent rather than becoming an explicit null,
 * so an unchanged TOASTed column is not reported as having been cleared.
 */
export function maskRecord(
  record: Record<string, unknown> | null,
  masked: Iterable<string>,
  verdicts: Map<string, boolean | null>,
): Record<string, unknown> | null {
  return maskRecordWithReport(record, masked, verdicts).record
}

/**
 * {@link maskRecord}, and which columns it nulled.
 *
 * A masked column reaches a subscriber as `null`, indistinguishable from a stored null. The
 * inspector needs the difference to show "redacted" rather than a value nobody stored, so the
 * masking step reports it; the frame a subscriber receives is unchanged.
 */
export function maskRecordWithReport(
  record: Record<string, unknown> | null,
  masked: Iterable<string>,
  verdicts: Map<string, boolean | null>,
): { record: Record<string, unknown> | null; redacted: string[] } {
  if (!record) return { record, redacted: [] }

  let copy: Record<string, unknown> | null = null
  const redacted: string[] = []
  for (const column of masked) {
    if (!(column in record)) continue
    if (verdicts.get(column) === true) continue
    copy ??= { ...record }
    copy[column] = null
    redacted.push(column)
  }

  return { record: copy ?? record, redacted }
}

/** The columns of each side of a change shown as null because they were masked or redacted. */
export interface RedactedColumns {
  old: string[]
  new: string[]
}

/**
 * Null every read-restricted column of a delivered change, whoever it was delivered to.
 *
 * The inspector's `redacted` view, for a viewer who may read rows but has no project identity to
 * judge field rules as. `restricted` is the table's restricted columns; `"*"` in it is the catalog's
 * "unknown", which redacts every column rather than guessing which ones are safe.
 */
export function redactRestricted(
  sides: { old: Record<string, unknown> | null; new: Record<string, unknown> | null },
  restricted: ReadonlySet<string>,
): { oldRecord: Record<string, unknown> | null; newRecord: Record<string, unknown> | null; redacted: RedactedColumns } {
  const nothingAllowed = new Map<string, boolean | null>()
  const side = (record: Record<string, unknown> | null) =>
    maskRecordWithReport(record, restricted.has("*") && record ? Object.keys(record) : restricted, nothingAllowed)
  const oldSide = side(sides.old)
  const newSide = side(sides.new)
  return {
    oldRecord: oldSide.record,
    newRecord: newSide.record,
    redacted: { old: oldSide.redacted, new: newSide.redacted },
  }
}
