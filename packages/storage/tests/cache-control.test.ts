/**
 * Every download used to answer `Cache-Control: public`, so a private file fetched with a user's
 * session could be kept by a shared cache or CDN and served to anyone who asked for the same URL.
 */
import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import sharp from "sharp"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { BucketRow } from "../src/db.js"
import type { RequestContext } from "../src/server.js"

vi.mock("../src/db.js", () => ({ getBucket: vi.fn(), touchObject: vi.fn(), readVerdict: vi.fn() }))
vi.mock("../src/object-store.js", () => ({ getObject: vi.fn(), objectKey: (name: string) => name }))
vi.stubEnv("JWT_SECRET", "cache-control-test-secret-at-least-32-chars")
/** Not the 3600 a plain file gets, so a transform answering the plain max-age shows. */
const TRANSFORM_TTL = 86400
vi.stubEnv("TRANSFORM_CACHE_TTL", String(TRANSFORM_TTL))

const db = await import("../src/db.js")
const store = await import("../src/object-store.js")
const { downloadPublic, downloadAuthenticated, downloadSigned } = await import("../src/routes/objects.js")
const { createSignedToken } = await import("../src/middleware/signed-urls.js")

const NOW = new Date("2026-11-13T12:00:00Z")
const TRANSFORM = "width=8&format=webp"
let png: Buffer = Buffer.alloc(0)

function bucket(access_mode: BucketRow["access_mode"]): BucketRow {
  return {
    id: "b",
    name: "b",
    public: access_mode === "public",
    access_mode,
    file_size_limit: null,
    allowed_mime_types: null,
    s3_bucket_policy: null,
    created_at: "",
    updated_at: "",
  }
}

/** The Cache-Control a route answered `query` with, after checking it answered 200. */
async function answeredCacheControl(route: (ctx: RequestContext) => Promise<void>, query: string, jwt: RequestContext["jwt"] = null): Promise<string> {
  const req = new IncomingMessage(new Socket())
  const res = new ServerResponse(req)
  // writeHead keeps the headers it is given readable by getHeader only once one has been set.
  res.setHeader("X-Test", "1")
  res.end = () => res
  await route({ req, res, jwt, params: { bucket: "b", wildcard: "cat.png" }, url: new URL(`http://s/x?${query}`) })
  expect(res.statusCode).toBe(200)
  return String(res.getHeader("Cache-Control"))
}

/** A token signed at NOW for `ttl` seconds, with the clock then moved on `elapsed` seconds. */
function signedQuery(ttl: number, elapsed: number, extra: string): string {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  const token = createSignedToken("b", "cat.png", ttl)
  vi.setSystemTime(NOW.getTime() + elapsed * 1000)
  return `token=${encodeURIComponent(token)}${extra && `&${extra}`}`
}

beforeAll(async () => {
  png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#2a7" } }).png().toBuffer()
  vi.mocked(db.touchObject).mockResolvedValue({ name: "cat.png", version: null })
  vi.mocked(db.readVerdict).mockResolvedValue("visible")
  vi.mocked(store.getObject).mockImplementation(async () => ({ body: png, contentType: "image/png", contentLength: png.length }))
})

afterEach(() => {
  vi.useRealTimers()
})

/** Each kind of download: its name, the query that asks for it, and the max-age it is normally kept for. */
const KINDS = [
  ["a plain file", "", 3600],
  ["an image transform", TRANSFORM, TRANSFORM_TTL],
] as const

describe.each(KINDS)("%s", (_what, query, normalMaxAge) => {
  it("from a public bucket may be kept by any cache", async () => {
    vi.mocked(db.getBucket).mockResolvedValue(bucket("public"))
    expect(await answeredCacheControl(downloadPublic, query)).toBe(`public, max-age=${normalMaxAge}`)
  })

  it("read with the user's session is never kept by any cache", async () => {
    vi.mocked(db.getBucket).mockResolvedValue(bucket("private"))
    const jwt = { sub: "user-1", role: "authenticated" }
    expect(await answeredCacheControl(downloadAuthenticated, query, jwt)).toBe("private, no-store")
  })

  it("through a signed link is not cached past the token's expiry", async () => {
    vi.mocked(db.getBucket).mockResolvedValue(bucket("private"))
    expect(await answeredCacheControl(downloadSigned, signedQuery(120, 20, query))).toBe("public, max-age=100")
  })

  it("through a signed link that outlives the normal max-age keeps that max-age", async () => {
    vi.mocked(db.getBucket).mockResolvedValue(bucket("private"))
    const outlives = signedQuery(7 * 86400, 0, query)
    expect(await answeredCacheControl(downloadSigned, outlives)).toBe(`public, max-age=${normalMaxAge}`)
  })
})
