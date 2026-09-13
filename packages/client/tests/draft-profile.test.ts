import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryBuilder } from "../src/query.js"
import { DRAFT_SCHEMA } from "../src/types.js"
import { createClient } from "../src/index.js"

// Reading a draft changes one thing about the request: which schema answers it. Same table name,
// same row type, one header. These tests pin that the header is actually sent, because a silently
// dropped `Accept-Profile` reads as "there is no draft" rather than as a failure.

const BASE = "http://localhost:18473"
const HEADERS: Record<string, string> = { apikey: "anon-key" }

function captureHeaders(): {
  headers: () => Record<string, string>
  fetch: ReturnType<typeof vi.fn>
} {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue([]),
    headers: { get: () => null },
  })
  vi.stubGlobal("fetch", fetch)
  return {
    fetch,
    headers: () => {
      const init = (fetch.mock.calls[0] as [string, { headers: Record<string, string> }])[1]
      return init.headers
    },
  }
}

const SESSION_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  // { "sub": "u1", "role": "authenticated" }
  "eyJzdWIiOiJ1MSIsInJvbGUiOiJhdXRoZW50aWNhdGVkIn0.sig"

describe("the draft profile", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("is sent as Accept-Profile when the query asks for it", async () => {
    const captured = captureHeaders()
    await new QueryBuilder(BASE, "/rest/v1/posts", HEADERS, "id", undefined, undefined, {
      profile: DRAFT_SCHEMA,
    })
    expect(captured.headers()["Accept-Profile"]).toBe("draft")
  })

  it("is absent from an ordinary read, so published content is what a caller gets by default", async () => {
    const captured = captureHeaders()
    await new QueryBuilder(BASE, "/rest/v1/posts", HEADERS, "id")
    expect(captured.headers()["Accept-Profile"]).toBeUndefined()
  })

  it("reaches the request through `from().draft().select()`", async () => {
    const captured = captureHeaders()
    const client = createClient({ url: BASE, anonKey: "anon-key" })
    await client.from("posts").draft().select("id, title")
    expect(captured.headers()["Accept-Profile"]).toBe("draft")
  })

  it("does not leak onto the next query from the same client", async () => {
    // `from()` builds a fresh table client per call, which is what makes `draft()` safe to be a
    // mutating step. If it ever stopped doing so, one draft read would silently make every
    // subsequent read a draft read.
    const client = createClient({ url: BASE, anonKey: "anon-key" })
    const drafted = captureHeaders()
    await client.from("posts").draft().select("id")
    expect(drafted.headers()["Accept-Profile"]).toBe("draft")

    vi.restoreAllMocks()
    const plain = captureHeaders()
    await client.from("posts").select("id")
    expect(plain.headers()["Accept-Profile"]).toBeUndefined()
  })

  it("leaves the count header alone, since a draft read can still be counted", async () => {
    const captured = captureHeaders()
    await new QueryBuilder(BASE, "/rest/v1/posts", HEADERS, "id", undefined, undefined, {
      profile: DRAFT_SCHEMA,
      count: "exact",
    })
    expect(captured.headers()["Accept-Profile"]).toBe("draft")
    expect(captured.headers()["Prefer"]).toBe("count=exact")
  })
})

describe("calling a function outside the default schema", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("sends Content-Profile so PostgREST looks in the right schema", async () => {
    // Without this the generated publishing functions are unreachable: PostgREST resolves
    // `/rpc/<name>` against the first schema on the exposed list, and `supatype.publish` is not
    // in it. The failure is a 404 that reads as "no such function" rather than as a routing
    // mistake.
    const captured = captureHeaders()
    const client = createClient({ url: BASE, anonKey: "anon-key" })
    await client.rpc("publish" as never, { model_table: "posts" } as never, { schema: "supatype" })
    expect(captured.headers()["Content-Profile"]).toBe("supatype")
  })

  it("sends none for a function in the default schema", async () => {
    const captured = captureHeaders()
    const client = createClient({ url: BASE, anonKey: "anon-key" })
    await client.rpc("calculate_shipping" as never, {} as never)
    expect(captured.headers()["Content-Profile"]).toBeUndefined()
  })
})

describe("a preview link as the client's credential", () => {
  beforeEach(() => vi.restoreAllMocks())

  /**
   * A fetch that answers the exchange and records every other request.
   *
   * The link is a short code now rather than a signed token, so the first thing a preview client
   * does is trade it in. That trade is why revoking one link works at all, and it means the header
   * these tests care about is on the *second* request, not the first.
   */
  function previewFetch(exchange: { ok: boolean; token?: string; expiresAt?: string }): {
    calls: () => Array<[string, { headers: Record<string, string> }]>
    queryHeaders: () => Record<string, string>
    exchanges: () => number
  } {
    const fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/preview-links/resolve")) {
        return Promise.resolve({
          ok: exchange.ok,
          status: exchange.ok ? 200 : 404,
          json: () =>
            Promise.resolve(
              exchange.ok
                ? { token: exchange.token, expiresAt: exchange.expiresAt }
                : { error: "gone" },
            ),
          headers: { get: () => null },
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
        headers: { get: () => null },
      })
    })
    vi.stubGlobal("fetch", fetch)
    const calls = (): Array<[string, { headers: Record<string, string> }]> =>
      fetch.mock.calls as Array<[string, { headers: Record<string, string> }]>
    return {
      calls,
      exchanges: () => calls().filter(([url]) => url.endsWith("/preview-links/resolve")).length,
      queryHeaders: () => {
        const call = calls().find(([url]) => !url.endsWith("/preview-links/resolve"))
        if (call === undefined) throw new Error("no query was made")
        return call[1].headers
      },
    }
  }

  const anHour = (): string => new Date(Date.now() + 3_600_000).toISOString()

  it("exchanges the code and sends what it gets back", async () => {
    const f = previewFetch({ ok: true, token: "exchanged.jwt", expiresAt: anHour() })
    const client = createClient({ url: BASE, anonKey: "anon-key", previewCode: "pl_abc.secret" })
    await client.from("posts").draft().select("id")
    expect(f.queryHeaders()["Authorization"]).toBe("Bearer exchanged.jwt")
  })

  it("never puts the code itself on the query", async () => {
    // The code is the credential and the exchange endpoint is the only thing that should ever see
    // it. Sending it onward would put it in the logs of everything downstream.
    const f = previewFetch({ ok: true, token: "exchanged.jwt", expiresAt: anHour() })
    const client = createClient({ url: BASE, anonKey: "anon-key", previewCode: "pl_abc.secret" })
    await client.from("posts").draft().select("id")
    expect(JSON.stringify(f.queryHeaders())).not.toContain("pl_abc")
  })

  it("keeps the anon apikey beside it, which the gateway still wants", async () => {
    const f = previewFetch({ ok: true, token: "exchanged.jwt", expiresAt: anHour() })
    const client = createClient({ url: BASE, anonKey: "anon-key", previewCode: "pl_abc.secret" })
    await client.from("posts").draft().select("id")
    expect(f.queryHeaders()["apikey"]).toBe("anon-key")
  })

  it("exchanges once for several queries in flight together", async () => {
    // Concurrent callers must share one exchange rather than each starting their own.
    const f = previewFetch({ ok: true, token: "exchanged.jwt", expiresAt: anHour() })
    const client = createClient({ url: BASE, anonKey: "anon-key", previewCode: "pl_abc.secret" })
    await Promise.all([
      client.from("posts").draft().select("id"),
      client.from("posts").draft().select("title"),
      client.from("authors").draft().select("id"),
    ])
    expect(f.exchanges()).toBe(1)
  })

  it("keeps the exchanged token for queries that come later", async () => {
    // Sequential, deliberately. Awaiting each one in turn means nothing is in flight to share, so
    // this is the only one of the two that fails if the token stops being cached: a page that
    // loads, then filters, then paginates would otherwise pay a round trip every time.
    const f = previewFetch({ ok: true, token: "exchanged.jwt", expiresAt: anHour() })
    const client = createClient({ url: BASE, anonKey: "anon-key", previewCode: "pl_abc.secret" })
    await client.from("posts").draft().select("id")
    await client.from("posts").draft().select("title")
    await client.from("authors").draft().select("id")
    expect(f.exchanges()).toBe(1)
  })

  it("reports a revoked link as an error rather than throwing", async () => {
    // The whole point of per-link revocation is that this happens. It has to arrive as a message a
    // preview route can render, not as an exception that takes the page down.
    previewFetch({ ok: false })
    const client = createClient({ url: BASE, anonKey: "anon-key", previewCode: "pl_dead.secret" })
    const { data, error } = await client.from("posts").draft().select("id")
    expect(data).toBeNull()
    expect(error?.message).toMatch(/expired, or been revoked/)
  })

  it("refuses to be built beside a service role key", () => {
    // The two are never both correct: a route with both is sending admin credentials down a path
    // meant for strangers, which is what the preview link exists to remove.
    expect(() =>
      createClient({
        url: BASE,
        anonKey: "anon-key",
        previewCode: "pl_abc.secret",
        serviceRoleKey: "service.jwt",
      }),
    ).toThrow(/cannot carry both/)
  })

  it("leaves an ordinary client alone", async () => {
    const captured = captureHeaders()
    const client = createClient({ url: BASE, anonKey: "anon-key" })
    await client.from("posts").select("id")
    expect(captured.headers()["Authorization"]).toBe("Bearer anon-key")
  })
})

describe("what storage sends as its credential", () => {
  // Storage was handed a plain headers object built when the client was constructed — before
  // anybody has signed in. Every storage request therefore carried the anon key for the life of the
  // page: an app's per-user storage policies saw `anon` rather than the caller, and through Studio's
  // proxy the request was refused outright, because an anon key carries no `sub` and the proxy
  // requires one. The symptom was "Token missing subject claim" on a page that lists buckets.
  //
  // Every other client on the object already resolved its headers per request. Storage was the one
  // that did not.

  function captureHeaders(): { headers: () => Record<string, string> } {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue([]),
      headers: { get: () => null },
    })
    vi.stubGlobal("fetch", fetchMock)
    return {
      headers: () => {
        const call = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
        return call[1].headers
      },
    }
  }

  it("uses the signed-in session, not the anon key it was built with", async () => {
    const captured = captureHeaders()
    const client = createClient({ url: BASE, anonKey: "anon-key" })
    // A session arriving after construction, which is the ordinary case: the client is built while
    // the page loads and the person signs in afterwards.
    ;(client.auth as unknown as { currentSession: unknown }).currentSession = {
      accessToken: SESSION_JWT,
      refreshToken: "r",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      user: { id: "u1" },
    }

    await client.storage.listBuckets()
    expect(captured.headers()["Authorization"]).toBe(`Bearer ${SESSION_JWT}`)
  })

  it("falls back to the anon key when nobody is signed in", async () => {
    const captured = captureHeaders()
    const client = createClient({ url: BASE, anonKey: "anon-key" })
    await client.storage.listBuckets()
    expect(captured.headers()["Authorization"]).toBe("Bearer anon-key")
  })

  it("uses the service role when the caller holds one", async () => {
    // Studio's own admin tooling, and anything else listing every bucket regardless of policy.
    const captured = captureHeaders()
    const client = createClient({ url: BASE, anonKey: "anon-key", serviceRoleKey: "service.jwt" })
    await client.storage.listBuckets()
    expect(captured.headers()["Authorization"]).toBe("Bearer service.jwt")
  })
})
