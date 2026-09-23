/**
 * Seed `.supatype/api-config.json`'s cache allowlist from what the schema declares.
 *
 * The declaration is a **ceiling**, not a switch: the server reads `cache` on the manifest as what
 * *may* be cached and `cache_tables` as what *is*. Both are needed, and only one of them is written
 * by a push — which on a local stack means a developer who wrote `cache: { enabled: true }`, pushed,
 * and called `.cache({ server: true })` gets a BYPASS and no explanation short of opening Studio.
 *
 * So a push turns on what the schema newly declares, and **never touches an entry that already
 * exists**. That asymmetry is the whole design:
 *
 *   - Seeding a new table is not a decision anyone made differently. The schema is the only thing
 *     that has ever said anything about it.
 *   - Rewriting an existing entry is `push resets to declared`, which §13.2 rejects by name: an
 *     operator narrows a table during an incident, someone pushes an unrelated model, and the
 *     mitigation is reverted at the worst possible moment with nothing in the output to say so.
 *
 * It follows that a table dropped from the schema keeps its entry here. That is not a leak: the
 * server intersects the allowlist with the declaration on every request, so an entry with no
 * declaration behind it caches nothing. Removing it would be tidier and would also mean a push
 * silently editing entries it did not create.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { manifestCache, type ManifestCacheEntry } from "./model-cache.js"

/** One table's entry in the runtime allowlist. The shape the server stores. */
interface TableCacheConfig {
  enabled: boolean
  allow_public: boolean
}

export interface CacheSeedResult {
  /** Tables switched on by this push because the schema had just started declaring them. */
  seeded: string[]
  /** True when every declared table is switched off project-wide by `cache_max_ttl: 0`. */
  ttlIsOff: boolean
  /** Tables the schema declares, whether or not this push changed anything. */
  declared: string[]
}

/**
 * Bring the local allowlist in line with new declarations, and report what is still in the way.
 *
 * Returns null when there is no file to seed — a cloud-only project, or a stack that has never
 * been started. A missing file is not an error here: the file is the local server's, and `dev`
 * creates it.
 */
export function seedApiConfigCache(cwd: string, ast: unknown): CacheSeedResult | null {
  const declared = manifestCache(ast)
  const declaredTables = Object.keys(declared).filter((t) => declared[t]?.enabled !== false).sort()

  const path = join(cwd, ".supatype", "api-config.json")
  if (!existsSync(path)) return null

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  } catch {
    // Malformed: the server reports this far more clearly than a push can, and rewriting it here
    // would destroy whatever the author was in the middle of.
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null

  const rest = asRecord(parsed["rest"])
  if (!rest) return null

  const tables = asRecord(rest["cache_tables"]) ?? {}
  const seeded: string[] = []
  for (const table of declaredTables) {
    if (table in tables) continue
    tables[table] = seedEntry(declared[table]!)
    seeded.push(table)
  }

  if (seeded.length > 0) {
    rest["cache_tables"] = tables
    parsed["rest"] = rest
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
  }

  const ttl = rest["cache_max_ttl"]
  return {
    seeded,
    // The project-wide TTL is deliberately not written. Zero is an operator's off switch, and a
    // push that turned it on would be overriding a decision rather than filling in a blank — so it
    // is reported instead, where the person who can decide is reading.
    ttlIsOff: declaredTables.length > 0 && (typeof ttl !== "number" || ttl <= 0),
    declared: declaredTables,
  }
}

/**
 * What a newly declared table is switched on as.
 *
 * `allow_public` follows the declaration rather than defaulting off: the schema saying `public` is
 * a considered statement that this table's reads are the same for everyone, and `push` has already
 * refused it where the read rule varies by caller. Defaulting it off would make the declaration
 * mean nothing until someone ticked a box that the schema had already justified.
 */
function seedEntry(entry: ManifestCacheEntry): TableCacheConfig {
  return { enabled: true, allow_public: entry.public === true }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * §13.4's note, in the words of the project that will read it — or null when there is nothing to
 * say.
 *
 * A free project with `cache` in its schema has asked for the paid feature **in code**. That is
 * better qualified than any banner, and it is why this names the tables: "your cache is off" is a
 * fact about the plan, while "posts and profiles are served from PostgREST on every request" is a
 * fact about their project.
 *
 * Said once per push and never as an error. Declaring a cache on a tier that does not honour it is
 * a correct declaration, not a mistake — the tier decides what runs, not what a schema may say —
 * and a push that failed over it would be punishing someone for writing down their intent.
 */
export function freeTierCacheNote(report: { tables?: string[]; honoured?: boolean } | undefined): string | null {
  // Absent, rather than `honoured: false`, is a control plane too old to answer. Silence is the
  // only honest response to a question that was never asked.
  if (!report || report.honoured !== false) return null
  const tables = (report.tables ?? []).filter((t) => typeof t === "string" && t.length > 0)
  if (tables.length === 0) return null

  return (
    `${listed(tables)} declare a cache in your schema. On the free tier these are served from ` +
    `PostgREST on every request — the declaration is stored and takes effect on a paid plan.`
  )
}

/** "posts", "posts and profiles", "posts, profiles and tags". */
function listed(tables: string[]): string {
  if (tables.length === 1) return tables[0]!
  return `${tables.slice(0, -1).join(", ")} and ${tables[tables.length - 1]!}`
}
