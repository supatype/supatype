import { afterEach, describe, expect, it, vi } from "vitest"
import { uploadHooks } from "../src/commands/push.js"

/**
 * Review of round 7: the hook upload had no time limit, so a target that accepted the connection and
 * never answered held `supatype push` for good after the schema went in. It has the limit a
 * functions deploy has: its route restarts the worker, and grows with the handlers it carries.
 */
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("a hook upload", () => {
  it("gives up after the limit a deploy of that many handlers has", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const asked: number[] = []
    const real = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      asked.push(ms)
      return real(ms)
    })
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: {} }), { headers: { "Content-Type": "application/json" } }))
    const target = { mode: "self-host", environment: "production", projectRef: "demo", apiBaseUrl: "https://stack.example.test", apiPrefix: "/platform/v1", token: "key", link: null } as const

    await uploadHooks(target, { handlers: [], map: { note: { beforeInsert: "audit" } } }, 2)

    expect(asked).toEqual([60_000 + 2 * 30_000])
  })
})
