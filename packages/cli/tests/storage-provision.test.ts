import { afterEach, describe, expect, it, vi } from "vitest"
import {
  bucketSpecsFromAst,
  provisionBuckets,
  provisionBucketsFromAst,
  type SchemaStorageBucketAst,
} from "../src/storage-provision.js"

describe("bucketSpecsFromAst", () => {
  it("maps storage bucket AST fields to API bucket specs", () => {
    const buckets: SchemaStorageBucketAst[] = [
      {
        id: "photos",
        public: false,
        accessMode: "private",
        allowedMimeTypes: ["image/jpeg"],
        fileSizeLimit: 5_000_000,
      },
      { id: "avatars", public: true },
    ]

    expect(bucketSpecsFromAst({ storageBuckets: buckets })).toEqual([
      {
        id: "photos",
        public: false,
        access_mode: "private",
        allowed_mime_types: ["image/jpeg"],
        file_size_limit: 5_000_000,
      },
      { id: "avatars", public: true },
    ])
  })

  it("returns an empty list when no buckets are declared", () => {
    expect(bucketSpecsFromAst({})).toEqual([])
  })
})

describe("provisionBuckets", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("POSTs each bucket to the storage API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true })
    vi.stubGlobal("fetch", fetchMock)

    await provisionBuckets("http://localhost:54321/storage/v1/", "service-key", [
      { id: "photos", public: false },
      { id: "avatars", public: true },
    ])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:54321/storage/v1/bucket",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer service-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: "photos", name: "photos", public: false }),
      }),
    )
  })

  it("treats 409 Conflict as success (bucket already exists)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 409, ok: false })
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      provisionBuckets("http://localhost:54321/storage/v1", "key", [{ id: "photos", public: false }]),
    ).resolves.toBeUndefined()
  })

  it("warns and continues when the storage API is unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")))

    await provisionBuckets("http://localhost:54321/storage/v1", "key", [{ id: "photos", public: false }])

    expect(warn).toHaveBeenCalledWith('[storage] Storage API unreachable — skipped bucket "photos"')
  })
})

describe("provisionBucketsFromAst", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("skips provisioning when the AST declares no buckets", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await provisionBucketsFromAst({}, "http://localhost:54321/storage/v1", "key")

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
