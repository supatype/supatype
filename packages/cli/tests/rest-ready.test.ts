import { describe, expect, it } from "vitest"
import { REST_READY_WITHIN_MS, waitForRestReady, type RestReadyDeps } from "../src/rest-ready.js"

/**
 * PU1: PostgREST 14 answers 503 (PGRST002) on every request while it cannot build its schema cache,
 * which on a fresh self-host stack is until the first push creates the schemas it is configured to
 * expose, and after a push it can take up to about 32 s to retry on its backoff. A push used to
 * report success while REST still answered 503. It now waits, bounded, until REST stops answering
 * 503, says once that it is waiting, and says plainly when it gave up.
 */

/** A stack whose REST answers each status in turn, then the last one for ever; the clock is fake. */
function stack(statuses: Array<number | Error>): { deps: RestReadyDeps; lines: string[]; requests: string[]; elapsed: () => number } {
  let now = 0
  let i = 0
  const lines: string[] = []
  const requests: string[] = []
  const deps: RestReadyDeps = {
    fetchStatus: async (url, headers) => {
      requests.push(`${url} apikey=${headers["apikey"] ?? ""}`)
      const next = statuses[Math.min(i++, statuses.length - 1)]
      if (next instanceof Error) throw next
      return next ?? 503
    },
    sleep: async (ms) => {
      now += ms
    },
    now: () => now,
    log: (line) => void lines.push(line),
  }
  return { deps, lines, requests, elapsed: () => now }
}

describe("waiting for REST after a push (PU1)", () => {
  it("returns at once, saying nothing, when REST already answers", async () => {
    const s = stack([200])

    expect(await waitForRestReady("http://localhost:55560", "anon-key", s.deps)).toBe(true)
    expect(s.lines).toEqual([])
    expect(s.requests).toEqual(["http://localhost:55560/rest/v1/ apikey=anon-key"])
  })

  it("waits through 503s, printing one line, until REST answers", async () => {
    const s = stack([503, 503, 503, 200])

    expect(await waitForRestReady("http://localhost:55560/", "anon-key", s.deps)).toBe(true)
    expect(s.requests).toHaveLength(4)
    expect(s.lines).toHaveLength(1)
    expect(s.lines[0]).toMatch(/waiting for the REST API/i)
  })

  it("keeps waiting while the gateway cannot be reached at all", async () => {
    const s = stack([new Error("ECONNREFUSED"), 503, 200])

    expect(await waitForRestReady("http://localhost:55560", "anon-key", s.deps)).toBe(true)
    expect(s.lines).toHaveLength(1)
  })

  it("only waits on 503: any other answer is REST's own and is left to the caller", async () => {
    const s = stack([401])

    expect(await waitForRestReady("http://localhost:55560", "anon-key", s.deps)).toBe(true)
    expect(s.requests).toHaveLength(1)
  })

  it("gives up at about 40 s and says what to do, without failing the push", async () => {
    const s = stack([503])

    expect(await waitForRestReady("http://localhost:55560", "anon-key", s.deps)).toBe(false)
    expect(REST_READY_WITHIN_MS).toBe(40_000)
    expect(s.elapsed()).toBeGreaterThanOrEqual(REST_READY_WITHIN_MS)
    expect(s.elapsed()).toBeLessThan(REST_READY_WITHIN_MS + 2_000)
    expect(s.lines).toHaveLength(2)
    expect(s.lines[1]).toMatch(/still answered 503 after 40 s/)
    expect(s.lines[1]).toMatch(/self-host compose logs --service postgrest/)
  })
})
