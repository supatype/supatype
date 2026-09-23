import type pg from "pg"

/**
 * Per-column masking for realtime payloads.
 *
 * Logical decoding does not plan a query, so nothing the `supatype_mask` extension does
 * reaches a WAL record, a column masked for a caller over REST would otherwise arrive
 * in full over the socket. Realtime has to apply the same rules itself.
 *
 * It does so from the same source of truth: the security labels the schema engine writes.
 * The rules stay in one place, and the predicate a subscriber is judged by is the exact
 * function the planner rewrite calls.
 */

/** The provider whose labels describe field access. Matches `supatype_mask`. */
const MASK_PROVIDER = "supatype"

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

interface CacheEntry {
  masks: ReadMasks
  readAt: number
}

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
  private cache = new Map<string, CacheEntry>()

  constructor(
    private pool: pg.Pool,
    private ttlMs = 30_000,
  ) {}

  invalidate(): void {
    this.cache.clear()
  }

  async readMasks(schema: string, table: string): Promise<ReadMasks> {
    const key = `${schema}.${table}`
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.readAt < this.ttlMs) return cached.masks

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

    this.cache.set(key, { masks, readAt: Date.now() })
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
  if (!record) return record

  let copy: Record<string, unknown> | null = null
  for (const column of masked) {
    if (!(column in record)) continue
    if (verdicts.get(column) === true) continue
    copy ??= { ...record }
    copy[column] = null
  }

  return copy ?? record
}
