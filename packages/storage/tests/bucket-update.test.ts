import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BucketAccessMode, BucketRow } from "../src/db.js"

vi.mock("../src/db.js", () => ({ getBucket: vi.fn(), updateBucket: vi.fn(), createBucket: vi.fn() }))
vi.mock("../src/s3.js", () => ({
  ensureBucket: vi.fn(),
  deleteBucket: vi.fn(),
  deleteObjects: vi.fn(),
  applyBucketPolicyFromConfig: vi.fn(),
  objectKey: vi.fn(),
}))
vi.stubEnv("JWT_SECRET", "bucket-update-test-secret")

const db = await import("../src/db.js")
const s3 = await import("../src/s3.js")
const buckets = await import("../src/routes/buckets.js")

/**
 * Whether a bucket serves anyone is read from `access_mode`, so a write that changes `public` has to
 * change the mode with it. `PUT /bucket/:id` with `{ public: true }` changed the flag alone, which
 * left the bucket private everywhere that reads the mode, and a custom bucket kept a `public: true`
 * that its S3 policy then opened to anyone. A write that changes neither leaves S3 alone.
 */
function row(access_mode: BucketAccessMode | null, isPublic: boolean): BucketRow {
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

function context(body: unknown): Parameters<typeof buckets.update>[0] {
  const req = new IncomingMessage(new Socket())
  req.push(JSON.stringify(body))
  req.push(null)
  const res = new ServerResponse(new IncomingMessage(new Socket()))
  res.end = () => res
  return { req, res, jwt: null, params: { id: "b" }, url: new URL("http://s/bucket/b") }
}

beforeEach(() => {
  vi.mocked(s3.applyBucketPolicyFromConfig).mockClear()
  vi.mocked(db.updateBucket).mockClear()
  vi.mocked(db.createBucket).mockClear()
})

describe("PUT /bucket/:id", () => {
  it.each([
    ["private", false, { public: true }, "public"],
    ["public", true, { public: false }, "private"],
    [null, false, { public: true }, "public"],
    [null, true, { file_size_limit: 10 }, "public"],
    ["public", true, { access_mode: "custom" }, "custom"],
    ["custom", true, { public: true }, "custom"],
  ] as const)("a %s bucket (public %s) given %o is written %s", async (mode, isPublic, body, nextMode) => {
    vi.mocked(db.getBucket).mockResolvedValue(row(mode, isPublic))
    vi.mocked(db.updateBucket).mockResolvedValue(row(nextMode, nextMode === "public"))
    await buckets.update(context(body))
    expect(vi.mocked(db.updateBucket).mock.lastCall?.[1]).toMatchObject({ access_mode: nextMode })
    expect(vi.mocked(s3.applyBucketPolicyFromConfig).mock.lastCall?.[1]).toMatchObject({ public: nextMode === "public" })
  })

  it.each([
    ["public", true, { public: true }],
    ["custom", false, { public: true }],
    ["private", false, { access_mode: "private" }],
  ] as const)("leaves a %s bucket (public %s) and its S3 policy alone given %o", async (mode, isPublic, body) => {
    vi.mocked(db.getBucket).mockResolvedValue(row(mode, isPublic))
    vi.mocked(db.updateBucket).mockResolvedValue(row(mode, isPublic))
    await buckets.update(context(body))
    expect(vi.mocked(db.updateBucket).mock.lastCall?.[1]).not.toHaveProperty("access_mode")
    expect(s3.applyBucketPolicyFromConfig).not.toHaveBeenCalled()
  })
})

describe("POST /bucket", () => {
  it("does not make a custom bucket public on S3", async () => {
    vi.mocked(db.createBucket).mockResolvedValue(row("custom", false))
    await buckets.create(context({ name: "b", public: true, access_mode: "custom" }))
    expect(vi.mocked(db.createBucket).mock.lastCall?.[2]).toBe("custom")
    expect(vi.mocked(s3.applyBucketPolicyFromConfig).mock.lastCall?.[1]).toMatchObject({ public: false })
  })
})
