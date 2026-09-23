import { createServer, type Server } from "node:http"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"

/**
 * A readiness poll has to be able to give up, and has to poll an address that is bound.
 *
 * `supatype push` reported the schema applied and then appeared to hang, on a wait whose own error
 * message advertised 120 seconds. Two things were wrong. The loop was bounded by iterations rather
 * than by time, and each `fetch` carried no deadline of its own, so against a socket that accepts
 * and never answers undici's ~30s default applied instead of the intended 1s: "120 attempts, one
 * second apart" is really closer to an hour. And it polled `localhost`, which resolves to `::1`
 * first, where Docker Desktop's IPv6 relay accepts and then goes silent when unhealthy. Docker
 * publishes on `0.0.0.0`, so IPv4 is the address certainly bound.
 */

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  )
})

/** A server that accepts connections and never responds, like the unhealthy relay. */
async function blackHole(): Promise<number> {
  const server = createServer(() => {
    /* deliberately no response, and no socket close */
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return (server.address() as AddressInfo).port
}

const devCompose = (): string =>
  readFileSync(fileURLToPath(new URL("../src/dev-compose.ts", import.meta.url)), "utf8")

describe("a readiness attempt against a port that accepts and never answers", () => {
  it("ends promptly when it carries a deadline", async () => {
    const port = await blackHole()
    const started = Date.now()

    await expect(
      fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(300) }),
    ).rejects.toThrow()

    // Generous, because the point is that it returns at all rather than how fast.
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe("the polls the CLI actually runs", () => {
  it("give every attempt a deadline", () => {
    const source = devCompose()
    // `fetchWithin` is the only way to reach the gateway from a poll loop. A bare `fetch` inside
    // one is the bug: the loop's iteration count stops being its real bound.
    const helper = source.match(/async function fetchWithin\(/g) ?? []
    expect(helper.length, "the timeout helper should exist").toBe(1)

    const kongPoll = source.slice(
      source.indexOf("async function waitKongReady("),
      source.indexOf("async function provisionDockerStorageBuckets("),
    )
    // Strip the wrapper's own name before looking for a bare call, or `fetchWithin(` matches
    // `fetch(` and the check passes on exactly the code it exists to reject.
    const bare = kongPoll.replaceAll("fetchWithin(", "<<ok>>")
    expect(bare, "a poll loop must not call fetch without a deadline").not.toMatch(/\bfetch\(/)
    expect(kongPoll).toMatch(/fetchWithin\(/)
  })

  it("target IPv4, not a name that may resolve to an unbound address", () => {
    const source = devCompose()
    const kongPoll = source.slice(
      source.indexOf("async function waitKongReady("),
      source.indexOf("async function provisionDockerStorageBuckets("),
    )
    // The URLs written to `.env` and printed for the operator stay on `localhost`, deliberately:
    // those are for a browser. This is about what the CLI dials itself.
    expect(kongPoll).not.toContain("http://localhost:")
    expect(kongPoll).toMatch(/loopbackBase\(/)
  })
})
