import { describe, expect, it } from "vitest"
import { emptyCacheDescription } from "../src/views/RestCacheBrowser.js"
import {
  controlsFor,
  declaredTables,
  projectTtlCeiling,
  rowCacheLine,
  type DeclaredCache,
} from "../src/lib/cache-declaration.js"

/**
 * §13.2's rule, from the screen's side: the schema declares what is permitted, and Studio may only
 * narrow it. The server enforces that on both paths, so nothing here can widen anything — what it
 * can get wrong is refusing without saying why, which is a control that looks broken.
 */

const staleness = (ms: number) => `up to ${ms} ms behind.`

describe("what Studio may offer for a table", () => {
  it("offers nothing for a table the schema never declared, and says which line to add", () => {
    const c = controlsFor({}, "posts")
    expect(c.canEnable).toBe(false)
    expect(c.canAllowPublic).toBe(false)
    expect(c.reason.enable).toContain("cache: { enabled: true }")
    expect(c.reason.enable).toContain("posts")
  })

  it("reads an absent declaration as nothing permitted, not as no constraint", () => {
    // An older server omits the key entirely. Treating that as permission would offer controls
    // this project's own server refuses, and the save would silently undo every one of them.
    expect(controlsFor(undefined, "posts").canEnable).toBe(false)
  })

  it("does not tell someone to add a declaration that is already there", () => {
    // `enabled: false` is the one refusal that is a present line rather than a missing one.
    const c = controlsFor({ posts: { enabled: false } }, "posts")
    expect(c.canEnable).toBe(false)
    expect(c.reason.enable).toContain("enabled: false")
    expect(c.reason.enable).not.toContain("Add")
  })

  it("offers the switch where the schema permits it, with nothing to explain", () => {
    const c = controlsFor({ posts: { enabled: true, public: true } }, "posts")
    expect(c.canEnable).toBe(true)
    expect(c.canAllowPublic).toBe(true)
    expect(c.reason).toEqual({})
  })

  it("withholds the shared key unless the schema says public, and says what a shared key is", () => {
    for (const declared of [{ posts: { enabled: true } }, { posts: { enabled: true, public: false } }]) {
      const c = controlsFor(declared, "posts")
      expect(c.canEnable).toBe(true)
      expect(c.canAllowPublic).toBe(false)
      expect(c.reason.allowPublic).toContain("per-user")
    }
  })

  it("treats a declaration with only maxTtl or rows as a declaration", () => {
    // `enabled` absent is permission; only an explicit false is the opt-out. The server's
    // cacheceiling.Permits reads it the same way, and the two disagreeing about one manifest is a
    // screen that offers a control the save then undoes.
    expect(controlsFor({ posts: { rows: true } }, "posts").canEnable).toBe(true)
    expect(controlsFor({ posts: { maxTtl: 30 } }, "posts").canEnable).toBe(true)
  })
})

describe("the declared TTL cap", () => {
  it("names the cap where one is declared", () => {
    const c = controlsFor({ posts: { enabled: true, maxTtl: 30 } }, "posts")
    expect(c.ttlCeiling).toBe(30)
    expect(c.reason.ttl).toContain("30s")
  })

  it("reads zero as no cap rather than a cap of zero seconds", () => {
    // A cap of zero would be a declaration that permits caching and then forbids every entry.
    const c = controlsFor({ posts: { enabled: true, maxTtl: 0 } }, "posts")
    expect(c.ttlCeiling).toBeNull()
    expect(c.reason.ttl).toBeUndefined()
  })

  it("holds the project-wide number to the highest per-table cap, not the lowest", () => {
    // The lowest would let one model with a five-second cap drag every other table down to five
    // seconds. Each table is held to its own cap on the read path instead.
    const declared: DeclaredCache = {
      ticker: { enabled: true, maxTtl: 5 },
      posts: { enabled: true, maxTtl: 600 },
    }
    expect(projectTtlCeiling(declared)).toBe(600)
  })

  it("has no project-wide cap when no table declares one", () => {
    expect(projectTtlCeiling({ posts: { enabled: true } })).toBeNull()
    expect(projectTtlCeiling(undefined)).toBeNull()
  })
})

describe("which tables the schema declares", () => {
  it("lists them sorted, leaving out the hard opt-outs", () => {
    const declared: DeclaredCache = {
      posts: { enabled: true },
      archive: { enabled: false },
      comments: { maxTtl: 10 },
    }
    expect(declaredTables(declared)).toEqual(["comments", "posts"])
  })
})

describe("the row cache, which is shown and never offered", () => {
  const live = { state: "participating" as const, stale_after_ms: 200 }

  it("explains the absence of a switch rather than leaving a blank space", () => {
    const line = rowCacheLine({ posts: { enabled: true } }, "posts", live, staleness)
    expect(line.text).toContain("cache: { rows: true }")
    expect(line.text).toContain("previous row")
  })

  it("says it is serving, with the staleness window read live", () => {
    const line = rowCacheLine({ posts: { rows: true } }, "posts", { ...live, stale_after_ms: 900 }, staleness)
    expect(line.tone).toBe("good")
    expect(line.text).toContain("up to 900 ms behind")
  })

  it("does not report a declaration as a working cache", () => {
    // The schema saying `rows: true` is not the same claim as the row cache running, and a screen
    // that answered only the first would show a healthy line beside reads coming from the heap.
    for (const state of ["off", "unavailable"] as const) {
      const line = rowCacheLine({ posts: { rows: true } }, "posts", { state, stale_after_ms: 200 }, staleness)
      expect(line.tone).toBe("warn")
      expect(line.text).toContain("from the heap")
    }
    expect(rowCacheLine({ posts: { rows: true } }, "posts", null, staleness).tone).toBe("warn")
  })

  it("does not call a failed status read a disabled cache", () => {
    // These were the same line, and that cost a real diagnosis. `/admin/v1/cache/rowcache`
    // answered 502 on every database where the row cache was actually on, because the handler
    // scanned the view's boolean `registrations_loaded` into an int64. The view is EMPTY while
    // decoding is off, so there was no row, no scan and no error — turning the feature on is what
    // started the failure. The panel then reported the one working database as "not running",
    // which reads as "you have not configured this" and sends you to the schema.
    const line = rowCacheLine(
      { posts: { rows: true } },
      "posts",
      null,
      staleness,
      "cache/rowcache: 502",
    )
    expect(line.tone).toBe("warn")
    expect(line.text).toContain("could not read")
    expect(line.text).toContain("cache/rowcache: 502")
    expect(line.text).not.toContain("from the heap")
  })

  it("still says off when the cache really is off, error or not", () => {
    const off = { state: "off" as const, stale_after_ms: 200 }
    const line = rowCacheLine({ posts: { rows: true } }, "posts", off, staleness, "ignored")
    expect(line.text).toContain("from the heap")
  })

  it("keeps running-but-unregistered apart from both serving and off", () => {
    // Registration follows an affirmative write to the allowlist rather than a reconcile at
    // startup, so a push that adds `rows: true` leaves the table declared and not yet registered.
    // "Serving" and "off" are both the wrong thing to say about it, and there is a specific thing
    // to do.
    const line = rowCacheLine({ posts: { rows: true } }, "posts", { state: "idle", stale_after_ms: 200 }, staleness)
    expect(line.tone).toBe("neutral")
    expect(line.text).toContain("no tables registered yet")
    expect(line.text).toContain("up to 200 ms behind")
  })

  it("says a stalled cache is correct and merely slower", () => {
    const line = rowCacheLine({ posts: { rows: true } }, "posts", { state: "incoherent", stale_after_ms: 200 }, staleness)
    expect(line.tone).toBe("warn")
    expect(line.text).toContain("still correct")
  })
})

describe("the wire shape, against the side that writes it", () => {
  it("reads exactly the keys the CLI emits", async () => {
    // The declaration is written by `supatype push` (packages/cli), carried through the route
    // manifest by the server, and read here. Three processes, one shape, and a key renamed on the
    // emitting side would not fail a typecheck anywhere — this screen would simply find nothing
    // declared and report every table as uncacheable.
    const { readFileSync } = await import("node:fs")
    const { fileURLToPath } = await import("node:url")
    const src = readFileSync(
      fileURLToPath(new URL("../../cli/src/model-cache.ts", import.meta.url)),
      "utf8",
    )
    const block = src.match(/export interface ManifestCacheEntry \{([^}]*)\}/)
    expect(block, "ManifestCacheEntry was renamed or moved").not.toBeNull()
    const emitted = [...block![1]!.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]).sort()

    expect(emitted).toEqual(["enabled", "maxTtl", "public", "rows"])
  })
})

describe("an empty cache listing", () => {
  it("does not tell someone to enable what is already enabled", () => {
    // The single sentence this replaced opened with "Enable caching in settings above", which is
    // wrong for the person most likely to be reading it: the one who just switched it on and is
    // wondering why nothing is listed.
    const text = emptyCacheDescription("job_post", true)
    expect(text).not.toContain("Switch it on")
    expect(text).toContain("Caching is on")
  })

  it("names the opt-in, which is the usual reason nothing is cached", () => {
    // Browsing the app never populates this: the TTL is min(client, project, schema), and a
    // request naming no max-age asks for zero.
    const text = emptyCacheDescription("job_post", true)
    expect(text).toContain("cache({ server: true })")
    expect(text).toContain("a plain GET is not cached")
  })

  it("says an empty list is normal rather than a fault", () => {
    expect(emptyCacheDescription("job_post", true)).toContain("normal rather than a fault")
  })

  it("still gives the switch-it-on instruction when it is genuinely off", () => {
    const text = emptyCacheDescription("job_post", false)
    expect(text).toContain("Caching is off")
    expect(text).toContain("settings above")
  })

  it("keeps the unfiltered listing's own wording", () => {
    expect(emptyCacheDescription(null, false)).toBe("No cached REST responses yet.")
  })
})
