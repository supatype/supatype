import { vi, type Mock } from "vitest"
import { isJsonObject } from "../../src/json.js"

/**
 * A typed stand-in for `fetch`, and readers for what it was called with.
 *
 * The suites used to build `vi.fn()` (whose calls are `any[]`) and then assert each call into the
 * shape they expected. Typed as `fetch`, a call is `[input, init?]` and nothing needs asserting: a
 * header is read the way the server reads it (case-insensitively), and a body is parsed and checked.
 *
 * Not named `*.test.ts`, so vitest's default include does not collect it as a suite.
 */
export type FetchMock = Mock<typeof fetch>

/** A fetch mock, answering with `impl` when given one. */
export function mockFetch(impl?: typeof fetch): FetchMock {
  return impl === undefined ? vi.fn<typeof fetch>() : vi.fn<typeof fetch>(impl)
}

/** Statuses a Response may not carry a body with. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/** A JSON response, as a server would send it. */
export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const text = NULL_BODY_STATUSES.has(status) ? null : JSON.stringify(body)
  return new Response(text, { status, headers: { "Content-Type": "application/json", ...headers } })
}

/** A fetch that answers every call with a fresh copy of the same JSON response. */
export function fetchReturning(body: unknown, status = 200, headers: Record<string, string> = {}): FetchMock {
  return vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(body, status, headers)))
}

/** The `n`th call's URL and init, as `fetch` received them. Throws when there was no such call. */
export function fetchCall(fetch: FetchMock, n = 0): { url: string; init: RequestInit } {
  const call = fetch.mock.calls[n]
  if (call === undefined) throw new Error(`fetch was called ${fetch.mock.calls.length} times, not ${n + 1}`)
  const [input, init] = call
  return { url: requestUrl(input), init: init ?? {} }
}

/** Every call's URL and init, oldest first. */
export function fetchCalls(fetch: FetchMock): Array<{ url: string; init: RequestInit }> {
  return fetch.mock.calls.map(([input, init]) => ({ url: requestUrl(input), init: init ?? {} }))
}

/** The URL a `fetch` input names. */
export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  return input instanceof URL ? input.href : input.url
}

/** One request header, matched case-insensitively as a server matches it; null when absent. */
export function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name)
}

/** The request's body parsed as a JSON object. Throws when it is not one. */
export function jsonBody(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== "string") throw new Error("the request body is not a string")
  const body = JSON.parse(init.body)
  if (!isJsonObject(body)) throw new Error(`the request body is not a JSON object: ${init.body}`)
  return body
}
