import { afterEach, describe, expect, it, vi } from "vitest"
import { targetSchemaDiff, type DeployTarget } from "../src/resolve-target.js"

/**
 * Issue 31: `supatype diff` with the local stack down answered
 * `Unable to connect. Is the computer able to access the url?`, which is Bun's fetch error in the
 * compiled CLI (Node's is `fetch failed`). It named neither the address tried nor what to do.
 *
 * The errors below are the ones each runtime's fetch rejects with for a refused connection, as
 * captured from `bun -e` and `node -e` against a closed port: the shapes `targetFetch` is given.
 */

const URL_TRIED = "http://localhost:18473/platform/v1/projects/demo/schema/diff"

/** Bun's: an Error with `code: "ConnectionRefused"` and the URL as `path`. */
function bunRefused(): Error {
  return Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
    code: "ConnectionRefused",
    errno: 0,
    path: URL_TRIED,
  })
}

/** Node's: `TypeError: fetch failed`, its cause an AggregateError of one ECONNREFUSED per address. */
function nodeRefused(): Error {
  const perAddress = [
    Object.assign(new Error("connect ECONNREFUSED ::1:18473"), { code: "ECONNREFUSED", address: "::1", port: 18473 }),
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18473"), { code: "ECONNREFUSED", address: "127.0.0.1", port: 18473 }),
  ]
  const cause = Object.assign(new AggregateError(perAddress, ""), { code: "ECONNREFUSED" })
  return new TypeError("fetch failed", { cause })
}

/** Node's for one address: the cause is the errno error itself. */
function nodeRefusedOneAddress(): Error {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18473"), { code: "ECONNREFUSED" })
  return new TypeError("fetch failed", { cause })
}

function target(mode: "local" | "self-host"): DeployTarget {
  return {
    mode,
    environment: "local",
    projectRef: "demo",
    apiBaseUrl: "http://localhost:18473",
    apiPrefix: "/platform/v1",
    token: "service-role-key",
    link: null,
  }
}

/** The message `diff` prints when fetch rejects with `err`. */
async function diffFailure(mode: "local" | "self-host", err: Error): Promise<string> {
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(err)))
  const failed = await targetSchemaDiff(target(mode), { version: 2, models: {} }).then(
    () => "",
    (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
  )
  return failed
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("a diff against a local stack that is not running", () => {
  for (const [runtime, refused] of [
    ["the compiled CLI (Bun)", bunRefused],
    ["Node", nodeRefused],
    ["Node, one address", nodeRefusedOneAddress],
  ] as const) {
    it(`names the URL it tried and says to start supatype dev, under ${runtime}`, async () => {
      const message = await diffFailure("local", refused())
      expect(message).toContain(URL_TRIED)
      expect(message).toMatch(/connection refused/i)
      expect(message).toContain("supatype dev")
      expect(message).not.toMatch(/Is the computer able to access the url/)
    })
  }
})

describe("a diff against a server that is not answering", () => {
  it("names the URL, and does not send a self-hosted server's user to `supatype dev`", async () => {
    const message = await diffFailure("self-host", bunRefused())
    expect(message).toContain(URL_TRIED)
    expect(message).toMatch(/connection refused/i)
    expect(message).not.toContain("supatype dev")
  })

  it("passes any other failure through as it was", async () => {
    const message = await diffFailure("local", new Error("certificate has expired"))
    expect(message).toBe("certificate has expired")
  })
})
