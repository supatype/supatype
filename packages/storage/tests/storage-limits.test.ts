/**
 * Upload size and project quota, read from the environment the service starts with.
 *
 * An explicit `-1` used to mean "use the tier table", so a self-hosted project told it had no
 * quota still refused uploads past the free tier's 1 GiB. Unset keeps the tier table, which is
 * what a deployment that sets nothing has always had.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BucketRow } from "../src/db.js"

const GiB = 1024 * 1024 * 1024
const MiB = 1024 * 1024
const LIMIT_KEYS = ["PROJECT_TIER", "STORAGE_QUOTA", "TIER_MAX_UPLOAD_SIZE", "MAX_UPLOAD_SIZE"] as const

vi.mock("../src/db.js", () => ({ getTotalStorageUsage: vi.fn(async () => 2 * GiB) }))

/** The limits module as the service would load it with these variables set. */
async function limitsWith(vars: Partial<Record<(typeof LIMIT_KEYS)[number], string>>) {
  for (const key of LIMIT_KEYS) delete process.env[key]
  Object.assign(process.env, vars)
  vi.resetModules()
  return import("../src/middleware/storage-limits.js")
}

const bucket: BucketRow = {
  id: "b",
  name: "b",
  public: false,
  file_size_limit: null,
  allowed_mime_types: null,
  access_mode: "private",
  s3_bucket_policy: null,
  created_at: "1970-01-01T00:00:00Z",
  updated_at: "1970-01-01T00:00:00Z",
}

const saved = { ...process.env }

beforeEach(() => {
  process.env["JWT_SECRET"] = "storage-limits-test-secret"
})

afterEach(() => {
  process.env = { ...saved }
})

describe("storage quota", () => {
  it("does not refuse a 2 GiB project when STORAGE_QUOTA is -1", async () => {
    const limits = await limitsWith({ STORAGE_QUOTA: "-1" })
    expect(await limits.validateStorageQuota(MiB)).toBeNull()
  })

  it("keeps the free tier's 1 GiB when nothing is set", async () => {
    const limits = await limitsWith({})
    expect((await limits.validateStorageQuota(MiB))?.status).toBe(507)
  })

  it("applies an explicit quota", async () => {
    const limits = await limitsWith({ STORAGE_QUOTA: String(3 * GiB) })
    expect(await limits.validateStorageQuota(MiB)).toBeNull()
    expect((await limits.validateStorageQuota(2 * GiB))?.status).toBe(507)
  })

  it("refuses to start on a quota that is not a number", async () => {
    await expect(limitsWith({ STORAGE_QUOTA: "lots" })).rejects.toThrow(/STORAGE_QUOTA/)
  })
})

describe("per-file upload size", () => {
  it("accepts a 2 GiB file when TIER_MAX_UPLOAD_SIZE and MAX_UPLOAD_SIZE are -1", async () => {
    const limits = await limitsWith({ TIER_MAX_UPLOAD_SIZE: "-1", MAX_UPLOAD_SIZE: "-1" })
    expect(limits.validateFileSize(bucket, 2 * GiB)).toBeNull()
  })

  it("falls back to MAX_UPLOAD_SIZE when the tier limit is -1", async () => {
    const limits = await limitsWith({ TIER_MAX_UPLOAD_SIZE: "-1", MAX_UPLOAD_SIZE: String(100 * MiB) })
    expect(limits.getEffectiveMaxUploadSize(bucket)).toBe(100 * MiB)
  })

  it("keeps the free tier's 50 MiB when nothing is set", async () => {
    const limits = await limitsWith({})
    expect(limits.validateFileSize(bucket, 60 * MiB)?.status).toBe(413)
  })

  it("lets a bucket's own limit win over the project's", async () => {
    const limits = await limitsWith({ TIER_MAX_UPLOAD_SIZE: "-1", MAX_UPLOAD_SIZE: "-1" })
    expect(limits.validateFileSize({ ...bucket, file_size_limit: MiB }, 2 * MiB)?.status).toBe(413)
  })
})
