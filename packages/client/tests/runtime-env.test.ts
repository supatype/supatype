/**
 * A build that never received its address and anon key still finds them at run time.
 *
 * When Supatype hosts an app, `<script src="/supatype-env.js">` sets `globalThis.__SUPATYPE_ENV__`
 * to the deployment's `{ url, anonKey }`; a Next.js app gets the same script from the route
 * `@supatype/ssr/next` exports. The client reads it for whichever value it was not given.
 *
 * `createClient` never throws for a missing value. `next build` prerenders every static page, so a
 * client created at module scope runs during the build, which has no values and needs none: it
 * sends nothing. The first request is what needs them, so that is where the check is, and it reads
 * the page again then, because the script may load after the module that created the client.
 * With neither, that request throws one error naming the values, every name to set and each fix.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient, MissingClientValuesError, type SupatypeClient } from "../src/index.js"

const DEPLOYED = { url: "https://api.example.com", anonKey: "deployed-anon-key" }

const FRONTEND_PREFIXES = ["VITE_", "PUBLIC_", "NEXT_PUBLIC_", "EXPO_PUBLIC_"]

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Every request's address and apikey, answered with an empty list. */
function captureRequests(): Array<{ url: string; apikey: string | null }> {
  const seen: Array<{ url: string; apikey: string | null }> = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    seen.push({ url, apikey: new Headers(init?.headers).get("apikey") })
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
  })
  return seen
}

/** The error `run` throws or rejects with, or a failure when it settles without one. */
async function failureOf(run: () => unknown): Promise<unknown> {
  try {
    await run()
  } catch (err) {
    return err
  }
  throw new Error("expected the request to throw")
}

/** The message of the named error `run` fails with. */
async function namedErrorOf(run: () => unknown): Promise<string> {
  const err = await failureOf(run)
  expect(err).toBeInstanceOf(MissingClientValuesError)
  return err instanceof Error ? err.message : String(err)
}

/** Run as a page would: a `window`, which is where the client looks for the page's values. */
function inBrowser(): void {
  vi.stubGlobal("window", globalThis)
}

/** One request through each service the client fronts, so each is shown to check first. */
const FIRST_REQUESTS: ReadonlyArray<readonly [string, (client: SupatypeClient) => unknown]> = [
  ["a table read", (c) => c.from("posts").select()],
  ["a table write", (c) => c.from("posts").delete().eq("id", "1")],
  ["an rpc call", (c) => c.rpc("hello")],
  ["a sign-in", (c) => c.auth.signInWithPassword({ email: "a@example.com", password: "pw" })],
  ["a storage list", (c) => c.storage.from("avatars").list()],
  ["a bucket list", (c) => c.storage.listBuckets()],
  ["a function call", (c) => c.functions.invoke("hello")],
  ["a GraphQL query", (c) => c.graphql("{ __typename }")],
  ["a realtime connect", (c) => c.realtime.channel("public:posts").subscribe()],
]

describe("createClient without an address or anon key", () => {
  it("does not throw, so a page prerendered without values still builds", () => {
    expect(() => createClient({})).not.toThrow()
    expect(() => createClient({ url: "", anonKey: undefined })).not.toThrow()
  })

  it.each(FIRST_REQUESTS)("throws the named error on %s, and sends nothing", async (_label, request) => {
    const seen = captureRequests()
    await namedErrorOf(() => request(createClient({})))
    expect(seen).toEqual([])
  })

  it("names both values, every frontend name, the server names and each fix", async () => {
    inBrowser()
    const message = await namedErrorOf(() => createClient({}).from("posts").select())

    expect(message).toContain("API address and anon key")
    for (const prefix of FRONTEND_PREFIXES) {
      expect(message).toContain(`${prefix}SUPATYPE_URL`)
      expect(message).toContain(`${prefix}SUPATYPE_ANON_KEY`)
    }
    expect(message).toContain("supatype build")
    expect(message).toContain('<script src="/supatype-env.js" vite-ignore></script>')
    expect(message).toContain("app/supatype-env.js/route.ts")
    expect(message).toContain("@supatype/ssr/next")
    expect(message).toContain('strategy="beforeInteractive"')
  })

  it("names only the anon key when the address was given", async () => {
    inBrowser()
    const message = await namedErrorOf(() => createClient({ url: "https://built.example.com" }).from("posts").select())

    expect(message).toContain("no anon key")
    for (const prefix of FRONTEND_PREFIXES) expect(message).toContain(`${prefix}SUPATYPE_ANON_KEY`)
    expect(message).toContain("set SUPATYPE_ANON_KEY")
    expect(message).not.toContain("SUPATYPE_URL")
  })

  it("names only the address when the anon key was given", async () => {
    inBrowser()
    const message = await namedErrorOf(() => createClient({ anonKey: "built-key" }).from("posts").select())

    expect(message).toContain("no API address")
    for (const prefix of FRONTEND_PREFIXES) expect(message).toContain(`${prefix}SUPATYPE_URL`)
    expect(message).not.toContain("SUPATYPE_ANON_KEY")
  })

  it("does not fall back to the page's own origin for the address", async () => {
    vi.stubGlobal("location", { origin: "https://app.example.com" })
    const seen = captureRequests()

    const message = await namedErrorOf(() => createClient({ anonKey: "built-key" }).from("posts").select())

    expect(message).toContain("VITE_SUPATYPE_URL")
    expect(seen).toEqual([])
  })

  it("does not make up a public file URL with no address", async () => {
    await namedErrorOf(() => createClient({}).storage.from("avatars").getPublicUrl("a.png"))
  })
})

describe("the error on a server, where there is no page", () => {
  it("names the server's variables first, then the build-time names, and no page global", async () => {
    const message = await namedErrorOf(() => createClient({}).from("posts").select())

    expect(message).not.toContain("window.__SUPATYPE_ENV__")
    const serverNames = message.indexOf("Set SUPATYPE_URL and SUPATYPE_ANON_KEY in the server's environment")
    expect(serverNames).toBeGreaterThan(-1)
    expect(serverNames).toBeLessThan(message.indexOf("VITE_SUPATYPE_URL"))
    expect(message).toContain("createServerClient")
    expect(message).toContain("supatype build")
  })

  it("names only the server variable for the value that is missing", async () => {
    const message = await namedErrorOf(() => createClient({ url: "https://api.example.com" }).from("posts").select())

    expect(message).toContain("Set SUPATYPE_ANON_KEY in the server's environment")
    expect(message).not.toContain("SUPATYPE_URL")
  })
})

describe("the page's __SUPATYPE_ENV__", () => {
  it("supplies both values", async () => {
    vi.stubGlobal("__SUPATYPE_ENV__", DEPLOYED)
    const seen = captureRequests()

    const client = createClient({})
    await client.from("posts").select()

    expect(client.url).toBe(DEPLOYED.url)
    expect(seen[0]?.url.startsWith("https://api.example.com/rest/v1/posts")).toBe(true)
    expect(seen[0]?.apikey).toBe(DEPLOYED.anonKey)
  })

  it("is read at the first request, so a script that loads after the client is created counts", async () => {
    const seen = captureRequests()
    const client = createClient({ url: "", anonKey: undefined })
    expect(client.url).toBe("")

    vi.stubGlobal("__SUPATYPE_ENV__", DEPLOYED)
    await client.from("posts").select()
    await client.storage.listBuckets()

    expect(client.url).toBe(DEPLOYED.url)
    expect(seen.map((r) => r.url)).toEqual([
      expect.stringMatching(/^https:\/\/api\.example\.com\/rest\/v1\/posts/),
      "https://api.example.com/storage/v1/bucket",
    ])
    expect(seen.every((r) => r.apikey === DEPLOYED.anonKey)).toBe(true)
  })

  it("lets the values the client was given win", async () => {
    vi.stubGlobal("__SUPATYPE_ENV__", DEPLOYED)
    const seen = captureRequests()

    const client = createClient({ url: "https://built.example.com", anonKey: "built-key" })
    await client.from("posts").select()

    expect(client.url).toBe("https://built.example.com")
    expect(seen[0]?.apikey).toBe("built-key")
  })

  it("resolves each value on its own", async () => {
    vi.stubGlobal("__SUPATYPE_ENV__", DEPLOYED)
    const seen = captureRequests()

    await createClient({ url: "https://built.example.com" }).from("posts").select()
    await createClient({ anonKey: "built-key" }).from("posts").select()

    expect(seen.map((r) => [new URL(r.url).origin, r.apikey])).toEqual([
      ["https://built.example.com", DEPLOYED.anonKey],
      [DEPLOYED.url, "built-key"],
    ])
  })

  it.each([
    ["a string", "https://api.example.com"],
    ["null", null],
    ["an array", [DEPLOYED.url, DEPLOYED.anonKey]],
    ["fields of the wrong type", { url: 42, anonKey: { key: "x" } }],
    ["empty fields", { url: "", anonKey: "" }],
  ])("is ignored when it holds %s", async (_label, value) => {
    vi.stubGlobal("__SUPATYPE_ENV__", value)
    const message = await namedErrorOf(() => createClient({ url: "https://built.example.com" }).from("posts").select())
    expect(message).toContain("anon key")
  })

  it("is ignored for an address that is not http or https", async () => {
    vi.stubGlobal("__SUPATYPE_ENV__", { url: "javascript:alert(1)", anonKey: "k" })
    const message = await namedErrorOf(() => createClient({}).from("posts").select())
    expect(message).toContain("VITE_SUPATYPE_URL")
  })
})
