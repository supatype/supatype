import { describe, expect, it, vi } from "vitest"

/**
 * Local test round 4: bucket rows read back from the service gave `file_size_limit` as a string,
 * `"1000"`. The column is a bigint, which node-postgres reads as text, and the row was handed on as
 * it came. The limits the service accepts are safe integers, so they read back as numbers.
 */
const raw = { id: "b", name: "b", public: false, file_size_limit: "1000", allowed_mime_types: null, access_mode: "private", s3_bucket_policy: null, created_at: "", updated_at: "" }

vi.mock("pg", () => {
  class Pool {
    async query(): Promise<{ rows: unknown[] }> {
      return { rows: [raw, { ...raw, id: "c", file_size_limit: null }] }
    }
  }
  return { default: { Pool } }
})

vi.stubEnv("JWT_SECRET", "bucket-row-numbers-test-secret")

const db = await import("../src/db.js")

describe("a bucket row", () => {
  it("gives file_size_limit as a number, and null as null", async () => {
    expect((await db.getBucket("b"))?.file_size_limit).toBe(1000)
    expect((await db.listBuckets()).map((row) => row.file_size_limit)).toEqual([1000, null])
    expect((await db.createBucket("b", "b", "private", 1000)).file_size_limit).toBe(1000)
    expect((await db.updateBucket("b", { file_size_limit: 1000 }))?.file_size_limit).toBe(1000)
  })
})
