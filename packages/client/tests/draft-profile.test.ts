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
