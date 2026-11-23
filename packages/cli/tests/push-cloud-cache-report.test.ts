import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reportTargetPush } from "../src/commands/push.js"
import { isEnginePushResult } from "../src/engine-answers.js"
import type { DeployTarget } from "../src/resolve-target.js"

/**
 * Cloud's push route switches on the REST cache for newly declared tables and says which it
 * confirmed in `cache.enabled`. The CLI's Cloud path reported only the free-tier note, so a push
 * that had just turned caching on said nothing, where a self-host push names the tables.
 */
const said: string[] = []

beforeEach(() => {
  said.length = 0
  for (const stream of ["log", "warn", "error"] as const) {
    vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

const cloud = { mode: "cloud", environment: "production", link: null } as unknown as DeployTarget

describe("a Cloud push that enabled cached tables", () => {
  it("names the tables the server confirmed, in the self-host wording", () => {
    reportTargetPush(cloud, { cache: { tables: ["posts", "tags"], honoured: true, enabled: ["posts", "tags"] } }, false)
    expect(said.join("\n")).toContain("Server cache enabled for posts, tags")
  })

  it("names only the tables confirmed on when some were already on", () => {
    reportTargetPush(cloud, { cache: { tables: ["posts", "tags"], honoured: true, enabled: ["tags"] } }, false)
    const out = said.join("\n")
    expect(out).toContain("Server cache enabled for tags")
    expect(out).not.toContain("posts")
  })

  it("keeps the answer's enabled list through the response guard", () => {
    const answer = { cache: { tables: ["posts"], honoured: true, enabled: ["posts"] } }
    expect(isEnginePushResult(answer)).toBe(true)
  })
})

describe("a Cloud push whose control plane predates `enabled`", () => {
  it("prints what it printed before: the free-tier note, and no enabled line", () => {
    reportTargetPush(cloud, { cache: { tables: ["posts"], honoured: false } }, false)
    const out = said.join("\n")
    expect(out).toContain("posts declare a cache in your schema")
    expect(out).not.toContain("Server cache enabled")
  })

  it("prints nothing about the cache when no cache was reported", () => {
    reportTargetPush(cloud, {}, false)
    expect(said.join("\n")).not.toContain("cache")
  })

  it("prints nothing about the cache when enabled is empty", () => {
    reportTargetPush(cloud, { cache: { tables: ["posts"], honoured: true, enabled: [] } }, false)
    expect(said.join("\n")).not.toContain("cache")
  })
})

// A push never sets cache_max_ttl (zero is an off switch someone may have chosen), so a self-host push
// says while it is 0 that nothing is cached. Cloud's push reported nothing, so the first cacheable read
// was a BYPASS with no word of why.
describe("a Cloud push while the project-wide cache TTL is 0", () => {
  it("says nothing is cached until it is set in Studio, and not the self-host file", () => {
    reportTargetPush(cloud, { cache: { tables: ["posts", "tags"], honoured: true, enabled: ["posts", "tags"], cacheMaxTtl: 0 } }, false)
    const out = said.join("\n")
    expect(out).toContain("2 table(s) declare a cache, but cache_max_ttl is 0, so nothing is cached until it is set, under API > REST > Settings in Studio.")
    expect(out).not.toContain("api-config.json")
  })

  it("says it even when every declared table was already on", () => {
    reportTargetPush(cloud, { cache: { tables: ["posts"], honoured: true, enabled: [], cacheMaxTtl: 0 } }, false)
    const out = said.join("\n")
    expect(out).toContain("cache_max_ttl is 0")
    expect(out).not.toContain("Server cache enabled")
  })

  it("keeps the TTL through the response guard", () => {
    expect(isEnginePushResult({ cache: { tables: ["posts"], honoured: true, enabled: [], cacheMaxTtl: 0 } })).toBe(true)
  })

  it("is silent once it is above 0, when the control plane does not say, and when nothing declares a cache", () => {
    reportTargetPush(cloud, { cache: { tables: ["posts"], honoured: true, enabled: [], cacheMaxTtl: 30 } }, false)
    reportTargetPush(cloud, { cache: { tables: ["posts"], honoured: true, enabled: [] } }, false)
    reportTargetPush(cloud, { cache: { tables: [], honoured: true, enabled: [], cacheMaxTtl: 0 } }, false)
    expect(said.join("\n")).not.toContain("cache_max_ttl")
  })
})
