import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { freeTierCacheNote, seedApiConfigCache } from "../src/api-config-cache.js"

/**
 * Two things have to be true for a cached read to be served: the schema declares the table (the
 * ceiling) and the runtime allowlist has it on (what is active). A push writes the first. Without
 * this it does not write the second, and the symptom is a declaration that appears to do nothing
 * and a BYPASS header nobody asked about.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(apiConfig: unknown | null): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-seed-"))
  dirs.push(dir)
  if (apiConfig !== null) {
    mkdirSync(join(dir, ".supatype"), { recursive: true })
    writeFileSync(
      join(dir, ".supatype", "api-config.json"),
      typeof apiConfig === "string" ? apiConfig : JSON.stringify(apiConfig, null, 2),
      "utf8",
    )
  }
  return dir
}

/** The file as it now stands, typed loosely because these assertions are about what is in it. */
const read = (dir: string): { rest?: { cache_tables?: Record<string, unknown>; cache_max_ttl?: unknown } } =>
  JSON.parse(readFileSync(join(dir, ".supatype", "api-config.json"), "utf8")) as {
    rest?: { cache_tables?: Record<string, unknown>; cache_max_ttl?: unknown }
  }

const ast = (cache: unknown, table = "posts") => ({
  models: [{ name: "Post", annotations: { db: { tableName: table }, platform: { cache } } }],
})

const config = (rest: Record<string, unknown>) => ({
  rest: { schema: "public", max_rows: 1000, ...rest },
  graphql: { introspection: true },
})

describe("what a push switches on", () => {
  it("turns on a table the schema has just started declaring", () => {
    const dir = project(config({ cache_max_ttl: 60, cache_tables: {} }))

    const result = seedApiConfigCache(dir, ast({ enabled: true }))

    expect(result?.seeded).toEqual(["posts"])
    expect(read(dir).rest?.cache_tables).toEqual({ posts: { enabled: true, allow_public: false } })
  })

  it("follows the schema on public rather than defaulting it off", () => {
    // `public` in the schema is a considered statement that this table's reads are the same for
    // everyone, and push has already refused it where the read rule varies by caller. Defaulting
    // it off would make the declaration mean nothing until someone ticked the box it justified.
    const dir = project(config({ cache_max_ttl: 60, cache_tables: {} }))

    seedApiConfigCache(dir, ast({ enabled: true, public: true }))

    expect(read(dir).rest?.cache_tables).toEqual({ posts: { enabled: true, allow_public: true } })
  })

  it("never rewrites an entry that already exists", () => {
    // `push resets to declared` is the alternative §13.2 rejects by name: an operator narrows a
    // table during an incident, someone pushes an unrelated model, and the mitigation is reverted
    // at the worst possible moment with nothing in the output to say so.
    const dir = project(config({ cache_max_ttl: 60, cache_tables: { posts: { enabled: false, allow_public: false } } }))

    const result = seedApiConfigCache(dir, ast({ enabled: true, public: true }))

    expect(result?.seeded).toEqual([])
    expect(read(dir).rest?.cache_tables).toEqual({ posts: { enabled: false, allow_public: false } })
  })

  it("leaves a hard opt-out switched off", () => {
    // `enabled: false` is the schema declining, so there is nothing to turn on.
    const dir = project(config({ cache_max_ttl: 60, cache_tables: {} }))

    const result = seedApiConfigCache(dir, ast({ enabled: false }))

    expect(result?.seeded).toEqual([])
    expect(read(dir).rest?.cache_tables).toEqual({})
  })

  it("leaves an entry whose declaration has gone, and does not need to remove it", () => {
    // The server intersects the allowlist with the declaration on every request, so an entry with
    // nothing declaring it caches nothing. Removing it would be tidier and would also mean a push
    // editing entries it did not create.
    const dir = project(config({ cache_max_ttl: 60, cache_tables: { legacy: { enabled: true, allow_public: false } } }))

    seedApiConfigCache(dir, ast({ enabled: true }))

    const tables = read(dir).rest?.cache_tables ?? {}
    expect(tables["legacy"]).toEqual({ enabled: true, allow_public: false })
    expect(tables["posts"]).toEqual({ enabled: true, allow_public: false })
  })
})

describe("what it reports rather than fixes", () => {
  it("says so when the project-wide TTL is off", () => {
    // Zero is an off switch someone may have chosen. A push that turned it on would be overriding
    // a decision rather than filling in a blank, so it is reported where the person who can decide
    // is reading.
    const dir = project(config({ cache_max_ttl: 0, cache_tables: {} }))

    const result = seedApiConfigCache(dir, ast({ enabled: true }))

    expect(result?.ttlIsOff).toBe(true)
    expect(read(dir).rest?.cache_max_ttl).toBe(0)
  })

  it("says nothing about the TTL when no table declares a cache", () => {
    const dir = project(config({ cache_max_ttl: 0, cache_tables: {} }))
    expect(seedApiConfigCache(dir, ast(undefined))?.ttlIsOff).toBe(false)
  })
})

describe("files it will not touch", () => {
  it("does nothing where there is no local server to configure", () => {
    // A cloud-only project, or a stack that has never been started. Not an error: `dev` creates it.
    expect(seedApiConfigCache(project(null), ast({ enabled: true }))).toBeNull()
  })

  it("leaves a malformed file exactly as it found it", () => {
    // The server reports this far more clearly than a push can, and rewriting it would destroy
    // whatever the author was in the middle of.
    const dir = project("{ this is not json")
    expect(seedApiConfigCache(dir, ast({ enabled: true }))).toBeNull()
    expect(readFileSync(join(dir, ".supatype", "api-config.json"), "utf8")).toBe("{ this is not json")
  })

  it("does not invent a rest section in a file that has none", () => {
    const dir = project({ graphql: { introspection: true } })
    expect(seedApiConfigCache(dir, ast({ enabled: true }))).toBeNull()
    expect(read(dir).rest).toBeUndefined()
  })
})

describe("the free-tier note", () => {
  // §13.4: a free project with `cache` in its schema has asked for the paid feature in code, which
  // is better qualified than any banner — and it is why the note names the tables. "Your cache is
  // off" is a fact about the plan; "posts is served from PostgREST on every request" is a fact
  // about their project.
  it("names the tables rather than the feature", () => {
    expect(freeTierCacheNote({ tables: ["posts"], honoured: false })).toContain(
      "posts declare a cache in your schema",
    )
    expect(freeTierCacheNote({ tables: ["posts", "profiles"], honoured: false })).toContain(
      "posts and profiles",
    )
    expect(freeTierCacheNote({ tables: ["a", "b", "c"], honoured: false })).toContain("a, b and c")
  })

  it("says the declaration was kept, because it was", () => {
    // The tier decides what runs, not what a schema may say. A note that read as a rejection would
    // invite someone to delete a correct declaration.
    expect(freeTierCacheNote({ tables: ["posts"], honoured: false })).toContain("takes effect on a paid plan")
  })

  it("says nothing on a tier that honours the declaration", () => {
    expect(freeTierCacheNote({ tables: ["posts"], honoured: true })).toBeNull()
  })

  it("says nothing when the schema declared nothing", () => {
    expect(freeTierCacheNote({ tables: [], honoured: false })).toBeNull()
  })

  it("says nothing when nothing was reported at all", () => {
    // An engine push, or a control plane too old to answer. Absence is a question that was never
    // asked, and the only honest response to it is silence rather than an upsell.
    expect(freeTierCacheNote(undefined)).toBeNull()
    expect(freeTierCacheNote({})).toBeNull()
  })
})
