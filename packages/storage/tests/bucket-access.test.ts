import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import { describe, expect, it, vi } from "vitest"
import type { BucketRow } from "../src/db.js"

// Past the access check the route looks the object up, so a served bucket answers 404 here.
vi.mock("../src/db.js", () => ({ getBucket: vi.fn(), getObject: vi.fn(), touchObject: vi.fn() }))
vi.stubEnv("JWT_SECRET", "bucket-access-test-secret")

const db = await import("../src/db.js")
const { downloadPublic } = await import("../src/routes/objects.js")
const { getCorsHeaders } = await import("../src/middleware/cors.js")

/**
 * The public route and CORS took `public: true` as well as `access_mode`, so a custom or private
 * bucket with a stale flag was served to anyone while every other read refused it.
 */
function bucket(access_mode: BucketRow["access_mode"], isPublic: boolean): BucketRow {
  return {
    id: "b",
    name: "b",
    public: isPublic,
    access_mode,
    file_size_limit: null,
    allowed_mime_types: null,
    s3_bucket_policy: null,
    created_at: "",
    updated_at: "",
  }
}

async function publicStatus(row: BucketRow): Promise<number> {
  vi.mocked(db.getBucket).mockResolvedValue(row)
  const req = new IncomingMessage(new Socket())
  const res = new ServerResponse(req)
  res.end = () => res
  await downloadPublic({ req, res, jwt: null, params: { bucket: "b", wildcard: "x.png" }, url: new URL("http://s/x") })
  return res.statusCode
}

describe("a bucket whose access mode is not public", () => {
  it.each([
    ["custom", true],
    ["private", true],
  ] as const)("is not served on the public route as %s with public: true", async (mode, isPublic) => {
    expect(await publicStatus(bucket(mode, isPublic))).toBe(403)
    expect(getCorsHeaders(bucket(mode, isPublic))["Access-Control-Allow-Origin"]).toBeUndefined()
  })
})

describe("a bucket with no access mode", () => {
  // The schema engine writes NULL for a bucket that names no mode, which goes by `public`.
  it("is served on the public route when public is true", async () => {
    expect(await publicStatus(bucket(null, true))).toBe(404)
    expect(getCorsHeaders(bucket(null, true))["Access-Control-Allow-Origin"]).toBe("*")
  })

  it("is not served when public is false", async () => {
    expect(await publicStatus(bucket(null, false))).toBe(403)
  })
})
