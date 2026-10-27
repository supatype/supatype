/**
 * What the client does with a body the server really sends, rather than the one its types describe.
 *
 * Each case here was a cast that claimed a shape and, for some body the server can produce, was
 * wrong: a JWT payload `atob` cannot read, a bigint that node-postgres sends as a string, an error
 * the storage service writes under `error`, a JSON `null` where an object was assumed.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { decodeJwtPayload } from "../src/jwt.js"
import { identityFingerprint } from "../src/query-cache.js"
import { QueryBuilder } from "../src/query.js"
import { StorageClient } from "../src/storage.js"
import { createClient } from "../src/index.js"
import { applyRowChange } from "../src/table-subscription.js"
import { fetchReturning, jsonResponse, mockFetch } from "./support/fetch-mock.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A payload whose base64url encoding has a `-` or `_`, which `atob` refuses. */
const URL_SAFE_CLAIMS = { sub: "user-1", role: "authenticated", note: "a>?~b", name: "Zoë" }
const URL_SAFE_TOKEN = `e30.${Buffer.from(JSON.stringify(URL_SAFE_CLAIMS)).toString("base64url")}.sig`

describe("a JWT payload in base64url", () => {
  it("is one atob alone cannot read", () => {
    const segment = URL_SAFE_TOKEN.split(".")[1] ?? ""
    expect(segment).toMatch(/[-_]/)
    expect(() => atob(segment)).toThrow()
  })

  it("is decoded, so its claims are read", () => {
    expect(decodeJwtPayload(URL_SAFE_TOKEN.split(".")[1] ?? "")).toMatchObject({ sub: "user-1", role: "authenticated" })
  })

  it("keys the query cache by role and subject", () => {
    expect(identityFingerprint({ Authorization: `Bearer ${URL_SAFE_TOKEN}` }, "user")).toBe("authenticated:user-1")
  })

  it("is null when the segment is not JSON of an object", () => {
    expect(decodeJwtPayload(Buffer.from("[1]").toString("base64url"))).toBeNull()
    expect(decodeJwtPayload("not base64 at all!")).toBeNull()
  })
})

describe("storage bodies", () => {
  const storage = (): StorageClient => new StorageClient("http://storage.test", () => Promise.resolve({}))
  const BUCKET = {
    id: "avatars",
    name: "avatars",
    public: true,
    allowed_mime_types: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }

  it("reads a bucket's size limit as the number its type declares", async () => {
    // A Postgres bigint: node-postgres sends it as a string.
    vi.stubGlobal("fetch", fetchReturning([{ ...BUCKET, file_size_limit: "1048576" }]))
    const { data, error } = await storage().listBuckets()
    expect(error).toBeNull()
    expect(data?.[0]?.file_size_limit).toBe(1048576)
  })

  it("passes the service's reason for refusing a bucket, which it writes under `error`", async () => {
    vi.stubGlobal("fetch", fetchReturning({ error: "Bucket avatars already exists" }, 409))
    const { error } = await storage().createBucket("avatars")
    expect(error?.message).toBe("Bucket avatars already exists")
  })

  it("reports a refusal whose body is null with the fallback message", async () => {
    vi.stubGlobal("fetch", fetchReturning(null, 500))
    const { error } = await storage().from("avatars").upload("a.png", new Blob(["x"]))
    expect(error).toEqual({ message: "Upload failed", status: 500 })
  })
})

describe("graphql", () => {
  it("reports a JSON null body as an error rather than throwing", async () => {
    vi.stubGlobal("fetch", fetchReturning(null))
    const client = createClient({ url: "http://api.test", anonKey: "anon", auth: { persistSession: false } })
    const { data, error } = await client.graphql("{ a }")
    expect(data).toBeNull()
    expect(error?.message).toMatch(/not an object/)
  })
})

describe("reads that answer with no body", () => {
  it("maybeSingle() on a 204 is null rather than a throw", async () => {
    vi.stubGlobal("fetch", mockFetch(() => Promise.resolve(jsonResponse(null, 204))))
    const { data, error } = await new QueryBuilder("http://api.test", "/rest/v1/posts", {}).maybeSingle()
    expect(error).toBeNull()
    expect(data).toBeNull()
  })

  it("a body that is JSON but not rows is an error, not rows", async () => {
    vi.stubGlobal("fetch", fetchReturning("not rows"))
    const { data, error } = await new QueryBuilder("http://api.test", "/rest/v1/posts", {})
    expect(data).toBeNull()
    expect(error?.message).toMatch(/expected rows/)
  })
})

describe("applyRowChange", () => {
  const change = (eventType: "INSERT" | "UPDATE") => ({
    eventType,
    new: null,
    old: null,
    schema: "public",
    table: "post",
    commitTimestamp: "2026-01-01T00:00:00Z",
  })

  it("does not put a null among the rows for a change without its new row", () => {
    const rows = [{ id: 1 }]
    expect(applyRowChange(rows, change("INSERT"))).toEqual([{ id: 1 }])
    expect(applyRowChange([{ title: "no id" }], change("UPDATE"))).toEqual([{ title: "no id" }])
  })
})

describe("a refusal worded under `error`", () => {
  // The Studio proxy and the server's guards answer `{ "error": "..." }`. The RPC path read only
  // `message` and said "PostgREST error"; the table path said "Request failed".
  const REFUSED = 'Studio role "viewer" cannot perform this request'

  it("keeps the sentence on an RPC call", async () => {
    vi.stubGlobal("fetch", fetchReturning({ error: REFUSED }, 403))
    const client = createClient({ url: "http://api.test", anonKey: "anon", auth: { persistSession: false } })
    const { error } = await client.rpc("create_draft", {})
    expect(error?.message).toBe(REFUSED)
  })

  it("keeps the sentence on a table write", async () => {
    vi.stubGlobal("fetch", fetchReturning({ error: REFUSED }, 403))
    const client = createClient({ url: "http://api.test", anonKey: "anon", auth: { persistSession: false } })
    const { error } = await client.from("posts").update({ title: "x" }).eq("id", 1)
    expect(error?.message).toBe(REFUSED)
  })
})

describe("a functions worker refusal", () => {
  // The worker answers its own failures as `{ error: <code>, message }`; the code is under `error`.
  const client = (): ReturnType<typeof createClient> =>
    createClient({ url: "http://api.test", anonKey: "anon", auth: { persistSession: false } })

  it("carries the worker's code for a function that does not exist", async () => {
    vi.stubGlobal("fetch", fetchReturning({ error: "not_found", message: 'Function "nope" not found' }, 404))
    const { error } = await client().functions.invoke("nope")
    expect(error).toMatchObject({ code: "not_found", message: 'Function "nope" not found', status: 404 })
  })

  it("carries the worker's code for a handler that threw", async () => {
    vi.stubGlobal("fetch", fetchReturning({ error: "function_error", message: "boom" }, 500))
    const { error } = await client().functions.invoke("fn")
    expect(error).toMatchObject({ code: "function_error", message: "boom", status: 500 })
  })

  it("prefers a handler's own `code` over `error`", async () => {
    vi.stubGlobal("fetch", fetchReturning({ code: "out_of_stock", error: "conflict", message: "gone" }, 409))
    const { error } = await client().functions.invoke("fn")
    expect(error?.code).toBe("out_of_stock")
  })

  it("reads a handler's lone `error` string as the message, not the code", async () => {
    vi.stubGlobal("fetch", fetchReturning({ error: "Email already taken" }, 400))
    const { error } = await client().functions.invoke("fn")
    expect(error).toEqual({ message: "Email already taken", status: 400 })
  })

  it("reads the message the way every other refusal is read, `msg` and an empty `message` included", async () => {
    vi.stubGlobal("fetch", fetchReturning({ message: "", msg: "Rate limited" }, 429))
    const { error } = await client().functions.invoke("fn")
    expect(error).toEqual({ message: "Rate limited", status: 429 })
  })

  it("leaves the code unset when `error` is not a string", async () => {
    vi.stubGlobal("fetch", fetchReturning({ error: { detail: "x" }, message: "bad" }, 400))
    const { error } = await client().functions.invoke("fn")
    expect(error).not.toHaveProperty("code")
  })
})
