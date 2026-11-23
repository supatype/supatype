import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reportTargetPush } from "../src/commands/push.js"
import { targetSchemaPush, type DeployTarget } from "../src/resolve-target.js"

/**
 * Cloud answers a push as `{ data: result, cache }`, with the cache report beside `data`. The report
 * has to survive the CLI's unwrapping of `data`, so these tests send the raw body through the real
 * `targetSchemaPush` rather than handing `reportTargetPush` a result that already holds `cache`.
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
  vi.unstubAllGlobals()
})

const cloud: DeployTarget = {
  mode: "cloud",
  environment: "production",
  projectRef: "ref123",
  apiBaseUrl: "https://cloud.example.test",
  apiPrefix: "/platform/v1",
  token: "tok",
  link: null,
}

function answerWith(body: unknown): void {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }))
}

async function pushThenReport(body: unknown): Promise<string> {
  answerWith(body)
  const result = await targetSchemaPush(cloud, { version: 2, models: [], storageBuckets: [] }, { cwd: process.cwd() })
  reportTargetPush(cloud, result, false)
  return said.join("\n")
}

describe("a Cloud push answered as { data, cache }", () => {
  it("names the tables the control plane switched the cache on for", async () => {
    const out = await pushThenReport({
      data: { status: "applied" },
      cache: { tables: ["post"], honoured: true, enabled: ["post"] },
    })
    expect(out).toContain("Server cache enabled for post")
  })

  it("prints the free-tier note when the control plane did not honour the cache", async () => {
    const out = await pushThenReport({ data: { status: "applied" }, cache: { tables: ["post"], honoured: false } })
    expect(out).toContain("post declare a cache in your schema")
  })

  it("still reads a cache report inside data, and prefers it over a sibling", async () => {
    const out = await pushThenReport({
      data: { status: "applied", cache: { tables: ["a"], honoured: true, enabled: ["a"] } },
      cache: { tables: ["b"], honoured: true, enabled: ["b"] },
    })
    expect(out).toContain("Server cache enabled for a")
    expect(out).not.toContain("for b")
  })

  it("prints nothing about the cache when the answer carries none", async () => {
    const out = await pushThenReport({ data: { status: "applied" } })
    expect(out).not.toContain("cache")
  })
})
