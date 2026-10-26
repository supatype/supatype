/**
 * Lift each model's `cache` declaration into the shape the route manifest carries.
 *
 * Keyed by **table**, like `hooks` and `validators`, because that is what a REST path carries; the
 * model name never reaches the wire.
 *
 * ## Why the manifest and not the AST
 *
 * `supatype push` writes the declaration into `annotations.platform.cache` too, and the server does
 * not read it there. The schema engine writes `_supatype.schema_state.ast_snapshot` as
 * `serde_json::to_value(&ast)` (its own parsed struct, re-serialised), and its
 * `PlatformModelAnnotations` knows only `access` and `searchFields`. An unknown key is not an error
 * to serde; it is silently dropped. So a declaration left to ride the AST would vanish between here
 * and the server with nothing anywhere reporting it.
 *
 * `hooks` has always taken this route for the same reason. Plan §13.1 said otherwise and said to
 * verify before relying on it; this is the verified path.
 */
import { readEnvValue, upsertEnvFile } from "./env-file.js"
import { astModels, objectAt } from "./ast-read.js"

/** One table's cache declaration, as the manifest carries it. */
export interface ManifestCacheEntry {
  enabled?: boolean
  maxTtl?: number
  public?: boolean
  rows?: boolean
}

/**
 * Every model's cache declaration, keyed by table name.
 *
 * A model that declared nothing is absent rather than present-and-empty. The distinction is
 * load-bearing: the declaration is a ceiling, so "no entry" means *nothing may cache this table*,
 * and an empty entry would read as "declared, permitting nothing": the same outcome by a route
 * that looks like a bug.
 */
export function manifestCache(ast: unknown): Record<string, ManifestCacheEntry> {
  const out: Record<string, ManifestCacheEntry> = {}
  // Each step is checked, so a malformed model is skipped rather than throwing a TypeError out of
  // `supatype push`.
  for (const model of astModels(ast)) {
    const table = objectAt(model, "annotations", "db")?.["tableName"]
    const cache = objectAt(model, "annotations", "platform", "cache")
    if (typeof table !== "string" || table.length === 0) continue
    if (cache === undefined) continue

    const entry: ManifestCacheEntry = {}
    // Copied key by key rather than spread, so a field added to the AST shape has to be added here
    // deliberately. The manifest is a wire format read by another process; silently widening it is
    // how the two ends stop agreeing about what a field means.
    const { enabled, rows, maxTtl } = cache
    if (typeof enabled === "boolean") entry.enabled = enabled
    if (typeof cache["public"] === "boolean") entry.public = cache["public"]
    if (typeof rows === "boolean") entry.rows = rows
    if (typeof maxTtl === "number" && Number.isFinite(maxTtl) && maxTtl >= 0) entry.maxTtl = maxTtl

    if (Object.keys(entry).length > 0) out[table] = entry
  }
  return out
}

// ─── Row cache enablement ────────────────────────────────────────────────────

/** The two env names the Postgres image reads to turn Mode B on. */
export const ROWCACHE_DECODE_ENV = "SUPATYPE_KEYSPACE_ROWCACHE_DECODE"
export const ROWCACHE_READTHROUGH_ENV = "SUPATYPE_KEYSPACE_ROWCACHE_READTHROUGH"

/** Whether any model declares `cache: { rows: true }`. */
export function declaresRowCache(ast: unknown): boolean {
  return Object.values(manifestCache(ast)).some((entry) => entry.rows === true)
}

/**
 * Keep the row cache's two switches in `.env` matching what the schema declares.
 *
 * `cache: { rows: true }` registers a table with the row cache, and registration alone serves
 * nothing: Mode B needs `pg_keyspace.rowcache_decode` for the invalidation worker and
 * `rowcache_readthrough` to fill on a primary-key miss. Both are written by the image's entrypoint
 * from these variables, before any server starts, so they cannot be switched at runtime and cannot
 * be decided by the compose file alone: only a push knows whether any model declares `rows`.
 *
 * Without this the stack came up with the row-cache segment reserved, the tables registered, both
 * switches off and nothing anywhere saying so. Studio's panel was the only thing that reported it,
 * and it reported it as an operator's missing configuration rather than as a push that had not
 * finished the job.
 *
 * Written to `.env` rather than baked into the compose file for the same reason `SUPATYPE_KONG_PORT`
 * is: `self-host compose render` runs with no AST in hand, so a value the compose file hardcoded
 * would be whatever the last render guessed.
 *
 * Returns the new state when it changed, and null when it did not. A change needs the database
 * container recreated, which the caller is the one that can say. Writing "off" into a `.env` that
 * had never set either switch is not a change: nothing was on, and reporting it told a new project
 * its row cache had been switched off.
 */
export function syncRowCacheEnv(cwd: string, ast: unknown): "on" | "off" | null {
  const want = declaresRowCache(ast)
  const value = want ? "1" : "0"

  const current = readEnvValue(cwd, ROWCACHE_DECODE_ENV, "")
  const currentThrough = readEnvValue(cwd, ROWCACHE_READTHROUGH_ENV, "")
  if (current === value && currentThrough === value) return null

  upsertEnvFile(cwd, {
    [ROWCACHE_DECODE_ENV]: value,
    [ROWCACHE_READTHROUGH_ENV]: value,
  })
  if (!want && current !== "1" && currentThrough !== "1") return null
  return want ? "on" : "off"
}

/** What a row cache change means, for someone who has never heard of pg_keyspace. */
export function rowCacheChangeNote(state: "on" | "off"): string {
  return state === "on"
    ? "Row cache turned on in .env: a model declares cache: { rows: true }, so Postgres keeps those rows in memory for reads."
    : "Row cache turned off in .env: no model declares cache: { rows: true } any more."
}
