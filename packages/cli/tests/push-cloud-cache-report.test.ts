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
