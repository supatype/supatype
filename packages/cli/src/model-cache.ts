/**
 * Lift each model's `cache` declaration into the shape the route manifest carries.
 *
 * Keyed by **table**, like `hooks` and `validators`, because that is what a REST path carries — the
 * model name never reaches the wire.
 *
 * ## Why the manifest and not the AST
 *
 * `supatype push` writes the declaration into `annotations.platform.cache` too, and the server does
 * not read it there. The schema engine writes `_supatype.schema_state.ast_snapshot` as
 * `serde_json::to_value(&ast)` — its own parsed struct, re-serialised — and its
 * `PlatformModelAnnotations` knows only `access` and `searchFields`. An unknown key is not an error
 * to serde; it is silently dropped. So a declaration left to ride the AST would vanish between here
 * and the server with nothing anywhere reporting it.
 *
 * `hooks` has always taken this route for the same reason. Plan §13.1 said otherwise and said to
 * verify before relying on it; this is the verified path.
 */
import type { ModelCacheAst } from "./schema-ast-v2.js"

/** One table's cache declaration, as the manifest carries it. */
export interface ManifestCacheEntry {
  enabled?: boolean
  maxTtl?: number
  public?: boolean
  rows?: boolean
}

interface ShapedModel {
  annotations?: {
    db?: { tableName?: string }
    platform?: { cache?: ModelCacheAst }
  }
}

/**
 * Every model's cache declaration, keyed by table name.
 *
 * A model that declared nothing is absent rather than present-and-empty. The distinction is
 * load-bearing: the declaration is a ceiling, so "no entry" means *nothing may cache this table*,
 * and an empty entry would read as "declared, permitting nothing" — the same outcome by a route
 * that looks like a bug.
 */
export function manifestCache(ast: unknown): Record<string, ManifestCacheEntry> {
  const models = (ast as { models?: unknown[] })?.models
  if (!Array.isArray(models)) return {}

  const out: Record<string, ManifestCacheEntry> = {}
  for (const model of models) {
    // Guarded before the optional chains, not by them: `x?.y` protects against `x.y` being
    // nullish, not against `x` itself being null — so a malformed entry in the models array would
    // throw a TypeError out of `supatype push` rather than being skipped.
    if (typeof model !== "object" || model === null) continue
    const shaped = model as ShapedModel
    const table = shaped.annotations?.db?.tableName
    const cache = shaped.annotations?.platform?.cache
    if (typeof table !== "string" || table.length === 0) continue
    if (typeof cache !== "object" || cache === null) continue

    const entry: ManifestCacheEntry = {}
    // Copied key by key rather than spread, so a field added to the AST shape has to be added here
    // deliberately. The manifest is a wire format read by another process; silently widening it is
    // how the two ends stop agreeing about what a field means.
    if (typeof cache.enabled === "boolean") entry.enabled = cache.enabled
    if (typeof cache.public === "boolean") entry.public = cache.public
    if (typeof cache.rows === "boolean") entry.rows = cache.rows
    if (typeof cache.maxTtl === "number" && Number.isFinite(cache.maxTtl) && cache.maxTtl >= 0) {
      entry.maxTtl = cache.maxTtl
    }

    if (Object.keys(entry).length > 0) out[table] = entry
  }
  return out
}
