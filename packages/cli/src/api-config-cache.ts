/**
 * Seed `.supatype/api-config.json`'s cache allowlist from what the schema declares.
 *
 * The declaration is a **ceiling**, not a switch: the server reads `cache` on the manifest as what
 * *may* be cached and `cache_tables` as what *is*. Both are needed, and only one of them is written
 * by a push. On a local stack that means a developer who wrote `cache: { enabled: true }`, pushed,
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
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { manifestCache } from "./model-cache.js"
import { readJsonObjectFile } from "./json-file.js"
import { isJsonObject } from "@supatype/shared"
import type { CacheReport } from "./engine-push-output.js"
import { seedThroughStack, tableEntryFor } from "./api-config-stack.js"

/** The server's own default configuration (apiconfig.DefaultApiConfig), for a stack that has never written one. */
function defaultApiConfig(): Record<string, unknown> {
  return {
    rest: { schema: "public", max_rows: 1000, cache_max_ttl: 0, cache_tables: {} },
    graphql: { introspection: true, max_query_depth: 10, max_rows: 1000 },
  }
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
 * A missing file is created from the server's default shape, because nothing else ever creates it
 * for a user project: the server answers defaults without one and writes it only when something
 * PATCHes. Returns null only for a file this cannot safely edit (malformed, or no `rest` section),
 * and when nothing is declared and there is no file, so a project without a cache gets no new file.
 */
export function seedApiConfigCache(cwd: string, ast: unknown): CacheSeedResult | null {
  const declared = manifestCache(ast)
  const declaredTables = Object.keys(declared).filter((t) => declared[t]?.enabled !== false).sort()

  const path = join(cwd, ".supatype", "api-config.json")
  if (!existsSync(path) && declaredTables.length === 0) return null

  // Malformed: the server reports this far more clearly than a push can, and rewriting it here
  // would destroy whatever the author was in the middle of.
  const parsed = existsSync(path) ? readJsonObjectFile(path) : defaultApiConfig()
  if (parsed === undefined) return null

  const rest = asRecord(parsed["rest"])
  if (!rest) return null

  const tables = asRecord(rest["cache_tables"]) ?? {}
  const seeded: string[] = []
  for (const table of declaredTables) {
    if (table in tables) continue
    tables[table] = tableEntryFor(declared[table]!)
    seeded.push(table)
  }

  if (seeded.length > 0 || !existsSync(path)) {
    rest["cache_tables"] = tables
    parsed["rest"] = rest
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
  }

  const ttl = rest["cache_max_ttl"]
  return {
    seeded,
    // The project-wide TTL is deliberately not written. Zero is an operator's off switch, and a
    // push that turned it on would be overriding a decision rather than filling in a blank, so it
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
/**
 * What a push or a dev boot should say about cache seeding, as lines to print.
 *
 * Returns the text rather than printing it, because the two callers write to the console
 * differently and the thing worth sharing is the decision about what to say, not the formatting.
 * Extracted from `push` when `dev` grew the same need: `seedApiConfigCache` had exactly one caller
 * for a long time, which is why a stack brought up with `supatype dev` alone had no cache
 * allowlist at all and nothing anywhere said so.
 *
 * Never an error, and never a rewrite of an entry that already exists. See `seedApiConfigCache`.
 */
export async function cacheSeedingNotes(cwd: string, ast: unknown): Promise<string[]> {
  const declared = manifestCache(ast)
  const tables = Object.keys(declared).filter((t) => declared[t]?.enabled !== false).sort()
  if (tables.length === 0) return []

  // Through the running stack first, because that is the writer every mode shares. The file is
  // for a stack that is not answering yet.
  const stack = await seedThroughStack(cwd, declared, tables)
  if (stack.kind === "unavailable") return []
  if (stack.kind === "seeded") {
    return seedNotes(stack.seeded, tables.length, stack.cacheMaxTtl <= 0, "through the running stack")
  }
  const result = seedApiConfigCache(cwd, ast)
  if (result === null) {
    return [`Could not enable the server cache for ${tables.join(", ")}: .supatype/api-config.json could not be updated and the stack did not answer (${stack.reason}).`]
  }
  return seedNotes(result.seeded, tables.length, result.ttlIsOff, "in .supatype/api-config.json")
}

/** The lines for one seeding: what was switched on, and always the TTL note while the TTL is 0. */
function seedNotes(seeded: string[], declaredCount: number, ttlIsOff: boolean, where: string): string[] {
  const notes: string[] = []
  if (seeded.length > 0) {
    notes.push(`Server cache enabled for ${seeded.join(", ")} ${where}`)
  }
  if (ttlIsOff) {
    // A note rather than a fix. Zero is an off switch someone may have chosen, and a push that
    // turned caching on project-wide would be overriding a decision rather than filling in a blank.
    notes.push(
      `${declaredCount} table(s) declare a cache, but cache_max_ttl is 0, so nothing ` +
        `is cached until it is set, under API > REST > Settings or in .supatype/api-config.json.`,
    )
  }
  return notes
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isJsonObject(value) ? value : null
}

/**
 * §13.4's note, in the words of the project that will read it, or null when there is nothing to
 * say.
 *
 * A free project with `cache` in its schema has asked for the paid feature **in code**. That is
 * better qualified than any banner, and it is why this names the tables: "your cache is off" is a
 * fact about the plan, while "posts and profiles are served from PostgREST on every request" is a
 * fact about their project.
 *
 * Said once per push and never as an error. Declaring a cache on a tier that does not honour it is
 * a correct declaration, not a mistake (the tier decides what runs, not what a schema may say),
 * and a push that failed over it would be punishing someone for writing down their intent.
 */
export function freeTierCacheNote(report: CacheReport | undefined): string | null {
  // Absent, rather than `honoured: false`, is a control plane too old to answer. Silence is the
  // only honest response to a question that was never asked.
  if (!report || report.honoured !== false) return null
  const tables = (report.tables ?? []).filter((t) => typeof t === "string" && t.length > 0)
  if (tables.length === 0) return null

  return (
    `${listed(tables)} declare a cache in your schema. On the free tier these are served from ` +
    `PostgREST on every request; the declaration is stored and takes effect on a paid plan.`
  )
}

/**
 * The lines a Cloud push prints about the cache: the tables the server confirmed as switched on,
 * in the words a self-host push uses, then the free-tier note when the tier does not honour it.
 * A control plane that predates `enabled` sends none, so it prints the free-tier note alone.
 */
export function cloudCacheNotes(report: CacheReport | undefined): string[] {
  const enabled = (report?.enabled ?? []).filter((t) => t.length > 0)
  const notes = seedNotes(enabled, report?.tables?.length ?? 0, false, "on Supatype Cloud")
  const freeTier = freeTierCacheNote(report)
  return freeTier === null ? notes : [...notes, freeTier]
}

/** "posts", "posts and profiles", "posts, profiles and tags". */
function listed(tables: string[]): string {
  if (tables.length === 1) return tables[0]!
  return `${tables.slice(0, -1).join(", ")} and ${tables[tables.length - 1]!}`
}
