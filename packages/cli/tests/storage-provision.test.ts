import { afterEach, describe, expect, it, vi } from "vitest"
import {
  bucketSpecsFromAst,
  nativeBucketRow,
  withPublicFromMode,
  provisionBuckets,
  provisionBucketsFromAst,
  unprovisionedBuckets,
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

  // 0.9.2, Nic's decision: single-bucket mode refuses a bucket policy and says what to do instead,
  // and push and dev print that whole, so the way out reaches whoever declared the policy.
  it("prints the service's whole reason for refusing a bucket policy in single-bucket mode", async () => {
    const reason =
      "s3BucketPolicy needs one S3 bucket per Supatype bucket, which single-bucket mode (S3_BUCKET) does not give. " +
      "Remove S3_BUCKET to use one S3 bucket per Supatype bucket (set S3_BUCKET_PREFIX to keep names unique), or drop s3BucketPolicy."
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: reason }), { status: 400, statusText: "Bad Request" })))

    await provisionBuckets("http://localhost:18473/storage/v1", "key", [{ id: "docs", s3_bucket_policy: "{}" }])

    expect(warn).toHaveBeenCalledWith(`[storage] Failed to provision bucket "docs": HTTP 400 Bad Request: ${reason}`)
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

  // 0.9.2 release test (N-FF11): a storage service that refused its S3 settings had exited, and
  // `compose up` printed only `HTTP 502 Bad Gateway, with an empty body` for each bucket.
  it("says once that the storage service is down when the gateway answers 502, and where to see why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("", { status: 502, statusText: "Bad Gateway" })))

    await provisionBuckets("http://localhost:18473/storage/v1", "key", [{ id: "avatars" }, { id: "docs" }], {
      storageLogs: "supatype self-host compose logs --service storage",
    })

    const down = warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("is not answering"))
    expect(down).toEqual([
      "[storage] The storage service is not answering behind the gateway (HTTP 502): it has stopped or is still starting. " +
        "See why: supatype self-host compose logs --service storage",
    ])
  })

  it("says the storage service is down without a command when the caller has none to name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 504, statusText: "Gateway Timeout" })))

    await provisionBuckets("http://localhost:18473/storage/v1", "key", [{ id: "docs" }])

    expect(warn).toHaveBeenLastCalledWith(
      "[storage] The storage service is not answering behind the gateway (HTTP 504): it has stopped or is still starting.",
    )
  })

  it("says nothing about the service being down when the service itself refused a bucket", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "invalid bucket id" }, { status: 400 })))

    await provisionBuckets("http://localhost:18473/storage/v1", "key", [{ id: "docs" }], { storageLogs: "logs" })

    expect(warn.mock.calls.some(([line]) => String(line).includes("is not answering"))).toBe(false)
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

  // Docker dev dropped the failures, so a bucket the service refused was said nowhere but a warning.
  it("says which buckets the service did not take, and how many were asked for", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) =>
      String(init?.body).includes('"pics"') ? Response.json({ error: "no" }, { status: 400 }) : Response.json({}),
    )
    const result = await provisionBucketsFromAst({ storageBuckets: [{ id: "pics" }, { id: "docs" }] }, "http://localhost:54321/storage/v1", "key")
    expect(result).toEqual({ total: 2, failed: ["pics"] })
    expect(unprovisionedBuckets(result)).toBe("1 of 2 bucket(s) were not provisioned: pics")
    expect(unprovisionedBuckets({ total: 2, failed: [] })).toBeNull()
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
