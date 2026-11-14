/**
 * Switch on newly declared cache tables through the running stack's admin API.
 *
 * `PATCH /admin/v1/config/rest` is the one writer every stack agrees on, so it works whatever the
 * server stores its configuration in, and it creates what is missing. The file seeding in
 * api-config-cache.ts is the fallback for a stack that is not answering.
 *
 * The PATCH replaces `cache_tables` as a whole, so the current map is read first and only
 * missing tables are added. An entry that already exists is never rewritten: see
 * api-config-cache.ts for why.
 */
import { isBoolean, isNumber, isRecordOf, isShape, nullable, optional, readJson } from "@supatype/shared"
import { adminHeaders } from "./rest-cache-admin.js"
import { resolveProjectApiUrl } from "./resolve-api-url.js"
import type { ManifestCacheEntry } from "./model-cache.js"

const REQUEST_TIMEOUT_MS = 5_000

export interface TableCacheEntry {
  enabled: boolean
  allow_public: boolean
}

const isTableEntry = isShape({ enabled: isBoolean, allow_public: isBoolean })

/** The parts of `GET` and `PATCH /admin/v1/config/rest` this reads. */
const isRestConfig = isShape({
  cache_max_ttl: optional(isNumber),
  cache_tables: optional(nullable(isRecordOf(isTableEntry))),
})

export type StackSeed =
  | { kind: "seeded"; seeded: string[]; cacheMaxTtl: number }
  /** The server refuses the cache here (a free Cloud plan), so nothing is wrong and nothing to seed. */
  | { kind: "unavailable" }
  /** Not answering, or answering something this cannot use. The caller falls back to the file. */
  | { kind: "unreachable"; reason: string }

/** What a newly declared table is switched on as. `allow_public` follows the declaration. */
export function tableEntryFor(entry: ManifestCacheEntry): TableCacheEntry {
  return { enabled: true, allow_public: entry.public === true }
}

export async function seedThroughStack(
  cwd: string,
  declared: Record<string, ManifestCacheEntry>,
  tables: string[],
): Promise<StackSeed> {
  try {
    const url = `${resolveProjectApiUrl(cwd)}/admin/v1/config/rest`
    const headers = adminHeaders(cwd)
    const current = await readJson(await fetchOk(url, { headers }), isRestConfig)
    const existing = current.cache_tables ?? {}
    const missing = tables.filter((t) => !(t in existing))
    if (missing.length === 0) return { kind: "seeded", seeded: [], cacheMaxTtl: current.cache_max_ttl ?? 0 }

    const cacheTables = { ...existing }
    for (const t of missing) cacheTables[t] = tableEntryFor(declared[t]!)
    const res = await fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ cache_tables: cacheTables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (res.status === 403) return { kind: "unavailable" }
    const after = await readJson(await ensureOk(res), isRestConfig)
    // The schema's ceiling can refuse a table the CLI asked for, so report what is actually on.
    const on = missing.filter((t) => after.cache_tables?.[t]?.enabled === true)
    return { kind: "seeded", seeded: on, cacheMaxTtl: after.cache_max_ttl ?? 0 }
  } catch (err) {
    return { kind: "unreachable", reason: err instanceof Error ? err.message : String(err) }
  }
}

async function fetchOk(url: string, init: { headers: Record<string, string> }): Promise<Response> {
  return ensureOk(await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }))
}

async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${res.url}`)
  return res
}
