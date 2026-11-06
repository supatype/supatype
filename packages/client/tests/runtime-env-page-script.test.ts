/**
 * A page whose `/supatype-env.js` gave it no values: the very first call says why, and sends nothing.
 *
 * A browser runs no script answered with an error status and shows the page nothing of why. So a
 * misconfigured server answers the script 200, setting `window.__SUPATYPE_ENV__ = {"error": "..."}`
 * to the reason its `.json` sibling gives as a 503, and the client quotes it. A page that has the
 * script element but no global at all did not run the script, and is told to open it. A page with no
 * element is told to add one.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient, MissingClientValuesError, type SupatypeClient } from "../src/index.js"

const REASON =
  "public env unavailable: SUPATYPE_ANON_KEY is not set on this server\n" +
  "public env unavailable: set SUPATYPE_URL or SUPATYPE_API_EXTERNAL_URL to this deployment's public API address"
const SCRIPT = "http://localhost:3000/supatype-env.js"
const ADD_THE_TAG = 'add <script src="/supatype-env.js"'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Run as a page whose scripts have `srcs`, with `env` as its `__SUPATYPE_ENV__` when given. */
function page(srcs: readonly string[], env?: unknown): void {
  vi.stubGlobal("window", globalThis)
  vi.stubGlobal("document", { scripts: srcs.map((src) => ({ src })) })
  if (env !== undefined) vi.stubGlobal("__SUPATYPE_ENV__", env)
}

/** A fetch that records every call and answers none, so a test can show nothing was sent. */
function recordFetch(): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(() => Promise.reject(new Error("no request may be sent")))
  vi.stubGlobal("fetch", fetch)
  return fetch
}

/**
 * The setup error `run` fails with, which must come before any timer runs: the reason is in the
 * page already, so nothing is waited for, not a request and not a deadline.
 */
async function firstCallError(run: () => unknown): Promise<MissingClientValuesError> {
  const late = Symbol("late")
  const timer = new Promise((resolve) => setTimeout(() => resolve(late), 0))
  let outcome: unknown
  try {
    outcome = await Promise.race([Promise.resolve().then(run), timer])
  } catch (err) {
    if (err instanceof MissingClientValuesError) return err
    throw err
  }
  throw new Error(outcome === late ? "the call had not failed before a timer ran" : "expected the call to fail")
}

/** The first call through each service, the ones that once gave the reason only on a second error. */
const FIRST_CALLS: ReadonlyArray<readonly [string, (client: SupatypeClient) => unknown]> = [
  ["a sign-in", (c) => c.auth.signInWithPassword({ email: "a@example.com", password: "pw" })],
  ["a realtime subscribe", (c) => c.realtime.channel("public:posts").subscribe()],
  ["a table read", (c) => c.from("posts").select()],
  ["a bucket file list", (c) => c.storage.from("avatars").list()],
  ["a table write", (c) => c.from("posts").delete().eq("id", "1")],
  ["a function call", (c) => c.functions.invoke("hello")],
]

describe("a page whose script set the server's reason", () => {
  it.each(FIRST_CALLS)("quotes it on %s, the first call, and sends nothing", async (_label, call) => {
    page([SCRIPT], { error: REASON })
    const fetch = recordFetch()

    const err = await firstCallError(() => call(createClient({})))

    expect(err.message).toContain(`${SCRIPT} set no API address and anon key, giving the server's reason instead:\n${REASON}\n`)
    expect(err.message).not.toContain(ADD_THE_TAG)
    expect(err.missing).toEqual(["url", "anonKey"])
    expect(fetch).not.toHaveBeenCalled()
  })

  it("says to fix the server that answers the script, then reload, and keeps the build-time fix", async () => {
    page([SCRIPT], { error: REASON })
    recordFetch()

    const { message } = await firstCallError(() => createClient({}).from("posts").select())

    expect(message).toContain("Fix that in the environment of the server that answers it")
    expect(message).toContain("app/supatype-env.js/route.ts")
    expect(message).toContain("reload the page")
    expect(message).toContain("VITE_SUPATYPE_ANON_KEY")
  })

  it("quotes it however the page loaded the script, by the global the script sets", async () => {
    page([], { error: REASON })
    recordFetch()

    const { message } = await firstCallError(() => createClient({}).from("posts").select())

    expect(message).toContain(`/supatype-env.js set no API address and anon key, giving the server's reason instead:\n${REASON}`)
  })

  it("names only the value the client was not given", async () => {
    page([SCRIPT], { error: REASON })
    recordFetch()

    const err = await firstCallError(() => createClient({ url: "https://built.example.com" }).from("posts").select())

    expect(err.missing).toEqual(["anonKey"])
    expect(err.message).toContain(`${SCRIPT} set no anon key, giving the server's reason instead`)
  })

  it("is not what a client given both values sees", async () => {
    page([SCRIPT], { error: REASON })
    const fetch = vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }))
    vi.stubGlobal("fetch", fetch)

    const result = await createClient({ url: "https://built.example.com", anonKey: "built-key" }).from("posts").select()

    expect(result.error).toBeNull()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([
    ["a number", 42],
    ["an empty string", "  "],
  ])("is not quoted when it is %s", async (_label, error) => {
    page([SCRIPT], { error })
    recordFetch()

    const { message } = await firstCallError(() => createClient({}).from("posts").select())

    expect(message).not.toContain("the server's reason")
    expect(message).toContain(`the page loads ${SCRIPT}`)
  })
})

describe("a page that has the script element but no __SUPATYPE_ENV__", () => {
  it("says the script did not run, and to open it in the browser, not to add it", async () => {
    page([SCRIPT])
    const fetch = recordFetch()

    const { message } = await firstCallError(() => createClient({}).from("posts").select())

    expect(message).toContain(`the page loads ${SCRIPT}, but it had set no window.__SUPATYPE_ENV__`)
    expect(message).toContain("blocked")
    expect(message).toContain("failed to load")
    expect(message).toContain("too old to serve it")
    expect(message).toContain(`Open ${SCRIPT} in the browser`)
    expect(message).not.toContain(ADD_THE_TAG)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("finds the element whatever the address before the path", async () => {
    page(["https://cdn.example.com/app.js", "https://app.example.com/base/supatype-env.js?v=2"])
    recordFetch()

    const { message } = await firstCallError(() => createClient({}).from("posts").select())

    expect(message).toContain("the page loads https://app.example.com/base/supatype-env.js?v=2")
  })
})

describe("a page with no script element", () => {
  it.each([
    ["no scripts", []],
    ["only other scripts", ["http://localhost:3000/app.js", "", "not a url"]],
  ])("still says to add it, with %s", async (_label, srcs) => {
    page(srcs)
    const fetch = recordFetch()

    const { message } = await firstCallError(() => createClient({}).from("posts").select())

    expect(message).toContain(ADD_THE_TAG)
    expect(message).not.toContain("did not run")
    expect(fetch).not.toHaveBeenCalled()
  })
})
