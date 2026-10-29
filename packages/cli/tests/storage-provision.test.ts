import { afterEach, describe, expect, it, vi } from "vitest"
import {
  bucketSpecsFromAst,
  nativeBucketRow,
  withPublicFromMode,
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
    ).resolves.toEqual([])
  })

  it("warns and continues when the storage API is unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")))

    const failed = await provisionBuckets("http://localhost:54321/storage/v1", "key", [{ id: "photos", public: false }])

    expect(warn).toHaveBeenCalledWith('[storage] Storage API unreachable, skipped bucket "photos"')
    // Named, so a caller that needs every bucket (native dev's import) can tell it did not happen.
    expect(failed).toEqual(["photos"])
  })

  // Local test round 3, N3: a 502 with an empty body printed `Failed to provision bucket "big": `.
  it("names the HTTP status when a refusal has an empty body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 502, statusText: "" })))

    await provisionBuckets("http://localhost:18473/storage/v1", "key", [{ id: "big" }])

    expect(warn).toHaveBeenCalledWith('[storage] Failed to provision bucket "big": HTTP 502, with an empty body')
  })

  it("names the HTTP status and the body when the storage API says why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const said = new Response('{"error":"invalid bucket id"}', { status: 400, statusText: "Bad Request" })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(said))

    await provisionBuckets("http://localhost:18473/storage/v1", "key", [{ id: "big" }])

    expect(warn).toHaveBeenCalledWith('[storage] Failed to provision bucket "big": HTTP 400 Bad Request: invalid bucket id')
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

describe("nativeBucketRow", () => {
  // Native dev writes buckets.json itself. A custom bucket declared public was written public
  // there, while the object store and the storage service hold that a custom bucket never is.
  it.each([
    [{ id: "b", public: true, accessMode: "custom" as const }, "custom", false],
    [{ id: "b", public: false, accessMode: "public" as const }, "public", true],
    [{ id: "b", public: true }, "public", true],
    [{ id: "b", public: false, accessMode: null }, "private", false],
  ])("writes %o with mode %s and public %s", (bucket, mode, isPublic) => {
    expect(nativeBucketRow(bucket, "t")).toMatchObject({ access_mode: mode, public: isPublic })
  })
})

describe("withPublicFromMode", () => {
  // Rows an earlier build wrote to buckets.json keep a custom bucket public until rewritten.
  it.each([
    [{ id: "b", public: true, access_mode: "custom" }, false],
    [{ id: "b", public: false, access_mode: "public" }, true],
    [{ id: "b", public: true }, true],
  ])("gives %o public %s", (row, isPublic) => {
    expect(withPublicFromMode(row)["public"]).toBe(isPublic)
  })
})
