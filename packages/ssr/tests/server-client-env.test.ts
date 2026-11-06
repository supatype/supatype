/**
 * `createServerClient` takes its address and anon key from `SUPATYPE_URL` and `SUPATYPE_ANON_KEY`
 * when it is not given them: the same two variables `@supatype/ssr/next` serves to the page, so a
 * Next.js server sets them once for both. Read when the client is created, at request time.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { MissingClientValuesError } from "@supatype/client"
import { createServerClient } from "../src/index.js"

const cookies = { getAll: (): Array<{ name: string; value: string }> => [] }

afterEach(() => {
  vi.unstubAllEnvs()
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

describe("createServerClient's address and anon key", () => {
  it("default to SUPATYPE_URL and SUPATYPE_ANON_KEY, given only the options", async () => {
    vi.stubEnv("SUPATYPE_URL", "https://api.example.com")
    vi.stubEnv("SUPATYPE_ANON_KEY", "server-anon")
    const seen = captureRequests()

    await createServerClient({ cookies }).from("posts").select()

    expect(seen[0]?.url.startsWith("https://api.example.com/rest/v1/posts")).toBe(true)
    expect(seen[0]?.apikey).toBe("server-anon")
  })

  it("default each on its own when passed as undefined", async () => {
    vi.stubEnv("SUPATYPE_URL", "https://api.example.com")
    vi.stubEnv("SUPATYPE_ANON_KEY", "server-anon")
    const seen = captureRequests()

    await createServerClient(undefined, "given-anon", { cookies }).from("posts").select()
    await createServerClient("https://given.example.com", undefined, { cookies }).from("posts").select()

    expect(seen.map((r) => [new URL(r.url).origin, r.apikey])).toEqual([
      ["https://api.example.com", "given-anon"],
      ["https://given.example.com", "server-anon"],
    ])
  })

  it("are the ones passed, whatever the environment holds", async () => {
    vi.stubEnv("SUPATYPE_URL", "https://api.example.com")
    vi.stubEnv("SUPATYPE_ANON_KEY", "server-anon")
    const seen = captureRequests()

    await createServerClient("https://given.example.com", "given-anon", { cookies }).from("posts").select()

    expect(seen[0]?.url.startsWith("https://given.example.com/")).toBe(true)
    expect(seen[0]?.apikey).toBe("given-anon")
  })

  it("fall back to the build-time NEXT_PUBLIC_ names when the server's own are unset", async () => {
    vi.stubEnv("SUPATYPE_URL", undefined)
    vi.stubEnv("SUPATYPE_ANON_KEY", undefined)
    vi.stubEnv("NEXT_PUBLIC_SUPATYPE_URL", "https://public.example.com")
    vi.stubEnv("NEXT_PUBLIC_SUPATYPE_ANON_KEY", "public-anon")
    const seen = captureRequests()

    await createServerClient({ cookies }).from("posts").select()

    expect(seen[0]?.url.startsWith("https://public.example.com/rest/v1/posts")).toBe(true)
    expect(seen[0]?.apikey).toBe("public-anon")
  })

  it("prefer the server's own names to the NEXT_PUBLIC_ ones, each on its own", async () => {
    vi.stubEnv("SUPATYPE_URL", "https://api.example.com")
    vi.stubEnv("SUPATYPE_ANON_KEY", undefined)
    vi.stubEnv("NEXT_PUBLIC_SUPATYPE_URL", "https://public.example.com")
    vi.stubEnv("NEXT_PUBLIC_SUPATYPE_ANON_KEY", "public-anon")
    const seen = captureRequests()

    await createServerClient({ cookies }).from("posts").select()

    expect(seen.map((r) => [new URL(r.url).origin, r.apikey])).toEqual([["https://api.example.com", "public-anon"]])
  })

  it("leave the first request to throw the named error when neither is anywhere", async () => {
    vi.stubEnv("SUPATYPE_URL", undefined)
    vi.stubEnv("SUPATYPE_ANON_KEY", undefined)
    vi.stubEnv("NEXT_PUBLIC_SUPATYPE_URL", undefined)
    vi.stubEnv("NEXT_PUBLIC_SUPATYPE_ANON_KEY", undefined)
    const seen = captureRequests()

    const client = createServerClient({ cookies })
    const err: unknown = await client.from("posts").select().then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(MissingClientValuesError)
    expect(seen).toEqual([])

    // On a server there is no page: the server's own variables come first, then the build-time ones.
    const message = err instanceof Error ? err.message : ""
    expect(message).not.toContain("window.__SUPATYPE_ENV__")
    const serverNames = message.indexOf("Set SUPATYPE_URL and SUPATYPE_ANON_KEY in the server's environment")
    expect(serverNames).toBeGreaterThan(-1)
    expect(serverNames).toBeLessThan(message.indexOf("NEXT_PUBLIC_SUPATYPE_URL"))
  })
})
