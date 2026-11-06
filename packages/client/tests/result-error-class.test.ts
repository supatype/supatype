/**
 * The `error` of a `{ data, error }` result is an `Error`, whatever produced it.
 *
 * It used to be a plain object typed `SupatypeError`, so `error instanceof Error` was false and
 * `String(error)` printed "[object Object]": a page that rendered a failed request's error showed
 * exactly that for a network failure or a CORS refusal. It is now a `SupatypeError`, with the
 * same `message`, `code` and `status` as before, and the same keys when it is turned into JSON.
 */

import { afterEach, assert, describe, expect, it, vi } from "vitest"
import { createClient, SupatypeError, type SupatypeClient } from "../src/index.js"
import { NetworkError } from "../src/errors.js"
import { reportThrown } from "../src/thrown-error.js"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type Request = (client: SupatypeClient) => PromiseLike<{ error: unknown }>

const client = (): SupatypeClient => createClient({ url: "http://127.0.0.1:9", anonKey: "x", retry: false })

/** Every request fails in transit, as fetch does when nothing listens on the port. */
function unreachable(): void {
  vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")))
}

/** Every request is answered with `status` and the JSON `body`. */
function answering(status: number, body: Record<string, unknown>): void {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
  )
}

/** The error a result carries is an Error that reads as its message and keeps the old JSON form. */
function expectResultError(error: unknown, shape: Record<string, unknown>): void {
  assert(error instanceof Error)
  expect(error).toBeInstanceOf(SupatypeError)
  expect(String(error)).toBe(`${error.name}: ${String(shape["message"])}`)
  expect(JSON.parse(JSON.stringify(error))).toEqual(shape)
  expect({ ...error }).toEqual(shape)
}

const NETWORK_FAILURES: ReadonlyArray<readonly [string, Request]> = [
  ["a table read", (c) => c.from("posts").select("id")],
  ["an rpc call", (c) => c.rpc("hello")],
  ["a bucket list", (c) => c.storage.listBuckets()],
  ["a GraphQL query", (c) => c.graphql("{ __typename }")],
  ["a function call", (c) => c.functions.invoke("hello")],
]

describe("a request that never got an answer", () => {
  it.each(NETWORK_FAILURES)("answers %s with an Error carrying the same fields", async (_label, request) => {
    unreachable()
    const { error } = await request(client())
    expectResultError(error, { message: "fetch failed", code: "NETWORK_ERROR" })
  })

  it("is the NetworkError the transport threw, so its class names the failure", async () => {
    unreachable()
    const { error } = await client().from("posts").select("id")
    expect(error).toBeInstanceOf(NetworkError)
    expect(String(error)).toBe("NetworkError: fetch failed")
  })

})

describe("a request the server refused", () => {
  it("answers a refused table read with an Error carrying the code and status", async () => {
    answering(403, { code: "42501", message: "permission denied for table posts" })
    const { error } = await client().from("posts").select("id")
    expectResultError(error, { message: "permission denied for table posts", code: "42501", status: 403 })
  })

  it("answers a refused storage list with an Error carrying the status", async () => {
    answering(403, { message: "not allowed" })
    const { error } = await client().storage.from("avatars").list()
    expectResultError(error, { message: "not allowed", status: 403 })
  })

  it("answers a refused sign-in with an Error carrying the auth code", async () => {
    answering(400, { error_code: "invalid_credentials", msg: "Invalid login credentials" })
    const { error } = await client().auth.signInWithPassword({ email: "a@example.com", password: "pw" })
    expectResultError(error, { message: "Invalid login credentials", code: "invalid_credentials", status: 400 })
  })

  it("answers a call needing a session with an Error when there is none", async () => {
    const { error } = await client().auth.updateUser({ data: {} })
    expectResultError(error, { message: "Not authenticated" })
  })
})

describe("a binding's thrown request", () => {
  it("holds a thrown string as an Error", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    expectResultError(reportThrown("useQuery(\"posts\")", "bad thing"), { message: "bad thing" })
  })

  it("holds the SDK's own errors as an Error with the result's fields", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    expectResultError(reportThrown("useQuery(\"posts\")", new NetworkError("offline")), {
      message: "offline",
      code: "NETWORK_ERROR",
    })
  })
})
