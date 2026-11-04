import { afterEach, describe, expect, it, vi } from "vitest"
import { afterHooksHealthLines, readAfterHooksHealth } from "../src/after-hooks-health.js"
import { RETAINED_WAL_WARN_BYTES, retainedWalCheck } from "../src/db-preflight.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A server whose `/health` answers `body`, recording the URL it was asked at. */
function serverAnswering(body: unknown, asked: string[] = []): void {
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url)
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
  })
}

describe("reading after-hooks from the server's /health", () => {
  it("reads components.after_hooks from the stack's /health", async () => {
    const asked: string[] = []
    serverAnswering({ status: "ok", components: { after_hooks: { path: "changelog", role: "reader", slot: "supatype_hooks" } } }, asked)
    expect(await readAfterHooksHealth("http://localhost:54321/")).toEqual({ path: "changelog", role: "reader", slot: "supatype_hooks" })
    expect(asked).toEqual(["http://localhost:54321/health"])
  })

  it("is undefined for a server from before the listener, so doctor asks the database instead", async () => {
    serverAnswering({ status: "ok", components: { postgrest: { ready: true } } })
    expect(await readAfterHooksHealth("http://localhost:54321")).toBeUndefined()
  })

  it("is undefined when nothing answers", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connect ECONNREFUSED")
    })
    expect(await readAfterHooksHealth("http://localhost:54321")).toBeUndefined()
  })
})

describe("what doctor says about the server's answer", () => {
  it("says the change log, and which replica reads it", () => {
    const out = afterHooksHealthLines({ path: "changelog", role: "reader", slot: "supatype_hooks" }).join("\n")
    expect(out).toContain("change log")
    expect(out).toContain("supatype_hooks")
  })

  it("says the request path, the server's reason, and what it misses", () => {
    const out = afterHooksHealthLines({ path: "request", slot: "supatype_hooks", reason: 'wal_level is "replica"' }).join("\n")
    expect(out).toContain("request path")
    expect(out).toContain('wal_level is "replica"')
    expect(out).toContain("outside the API")
  })

  it("warns when the slot holds a lot of WAL, and says the listener's last error", () => {
    const out = afterHooksHealthLines({
      path: "changelog",
      slot: "supatype_hooks",
      retained_wal_bytes: RETAINED_WAL_WARN_BYTES * 2,
      last_error: "hook timed out",
    }).join("\n")
    expect(out).toContain("2.0 GiB")
    expect(out).toContain("hook timed out")
  })

  it("does not warn below the threshold", () => {
    const out = afterHooksHealthLines({ path: "changelog", slot: "supatype_hooks", retained_wal_bytes: 1024 }).join("\n")
    expect(out).not.toContain("GiB")
  })

  it("says the path is not decided yet, rather than guessing one", () => {
    const out = afterHooksHealthLines({ path: "unknown", slot: "supatype_hooks" }).join("\n")
    expect(out).toContain("not decided")
  })
})

describe("db check: WAL held by Supatype's slots", () => {
  it("passes when no slot holds much", () => {
    expect(retainedWalCheck([{ slot_name: "supatype_hooks", retained: "4096" }]).severity).toBe("pass")
  })

  it("warns naming each slot over the threshold", () => {
    const check = retainedWalCheck([
      { slot_name: "supatype_realtime", retained: "10" },
      { slot_name: "supatype_hooks", retained: String(RETAINED_WAL_WARN_BYTES * 3) },
    ])
    expect(check.severity).toBe("warn")
    expect(check.detail).toContain("supatype_hooks holds 3.0 GiB")
    expect(check.detail).not.toContain("supatype_realtime")
  })
})
