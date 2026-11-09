/**
 * The S3 settings the service starts with, in its two modes.
 *
 * 0.9.2: with `S3_BUCKET` set, every Supatype bucket is a key prefix in that one S3 bucket, as
 * Supabase Storage keeps them under `GLOBAL_S3_BUCKET`. Such a deployment points at a bucket of its
 * own, on AWS (a region, no endpoint) or an S3-compatible store (an endpoint), so the defaults that
 * point at the self-host stack's SeaweedFS must never apply to it: a missing setting fails at start
 * rather than quietly sending every upload to localhost:8333 with a published login.
 *
 * Without `S3_BUCKET` the service maps each Supatype bucket to an S3 bucket of its own, exactly as
 * before, defaults included, so a self-host stack and any deployment already running keep working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const S3_KEYS = [
  "S3_BUCKET",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_FORCE_PATH_STYLE",
  "S3_PUBLIC_URL",
  "S3_BUCKET_PREFIX",
  "STORAGE_FILE_PATH",
  "STORAGE_BACKEND",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
] as const

type S3Vars = Partial<Record<(typeof S3_KEYS)[number], string>>

const saved = { ...process.env }

beforeEach(() => {
  process.env["JWT_SECRET"] = "s3-settings-test-secret"
})

afterEach(() => {
  process.env = { ...saved }
})

/** A path that never exists, so the SDK's chain finds no `~/.aws` on the machine running the tests. */
const NO_AWS_FILE = "/nonexistent/supatype-s3-settings-test"

/**
 * The S3 module as the service would load it with these variables set, and nothing else: no S3 or
 * AWS variable and no `~/.aws` files from the machine running the tests.
 */
async function s3With(vars: S3Vars) {
  for (const key of S3_KEYS) delete process.env[key]
  process.env["AWS_SHARED_CREDENTIALS_FILE"] = NO_AWS_FILE
  process.env["AWS_CONFIG_FILE"] = NO_AWS_FILE
  Object.assign(process.env, vars)
  vi.resetModules()
  return import("../src/s3.js")
}

describe("one S3 bucket (S3_BUCKET set)", () => {
  it("refuses to start with neither a region nor an endpoint, naming both", async () => {
    await expect(s3With({ S3_BUCKET: "shared" })).rejects.toThrow(/S3_REGION.*S3_ENDPOINT/)
  })

  it("refuses to start with an access key and no secret key", async () => {
    await expect(s3With({ S3_BUCKET: "shared", S3_REGION: "eu-west-2", S3_ACCESS_KEY: "id" })).rejects.toThrow(
      /S3_SECRET_KEY/,
    )
  })

  it("reads blank settings as unset, as init writes them into .env", async () => {
    await expect(s3With({ S3_BUCKET: "shared", S3_ENDPOINT: "", S3_REGION: "" })).rejects.toThrow(/S3_REGION/)
  })

  it("signs for the AWS region alone, at the shared bucket, under the Supatype bucket's prefix", async () => {
    const s3 = await s3With({ S3_BUCKET: "shared", S3_REGION: "eu-west-2", S3_ACCESS_KEY: "id", S3_SECRET_KEY: "secret" })
    const url = new URL(await s3.createSignedDownloadUrl("photos", "cats/a.png", 60))
    expect(url.host).toBe("shared.s3.eu-west-2.amazonaws.com")
    expect(url.pathname).toBe("/photos/cats/a.png")
  })

  it("takes credentials from the SDK's own chain when no keys are set", async () => {
    const s3 = await s3With({
      S3_BUCKET: "shared",
      S3_REGION: "eu-west-2",
      AWS_ACCESS_KEY_ID: "ambient-id",
      AWS_SECRET_ACCESS_KEY: "ambient-secret",
    })
    const credentials = await s3.s3.config.credentials()
    expect(credentials.accessKeyId).toBe("ambient-id")
  })

  it("uses path-style addressing at an endpoint, a region of us-east-1 when none is set", async () => {
    const s3 = await s3With({ S3_BUCKET: "shared", S3_ENDPOINT: "http://minio:9000", S3_ACCESS_KEY: "id", S3_SECRET_KEY: "secret" })
    const url = new URL(await s3.createSignedDownloadUrl("photos", "a.png", 60))
    expect(`${url.host}${url.pathname}`).toBe("minio:9000/shared/photos/a.png")
    expect(url.searchParams.get("X-Amz-Credential")).toContain("/us-east-1/s3/")
  })
})

/**
 * Nic's decision for 0.9.2: per-bucket mode has no defaults either. It used to fall back to
 * localhost:8333 and the published supatype/supatype-secret login whenever a setting was missing, so
 * a deployment pointed at its own endpoint without keys signed with that login. The compose stack
 * passes every setting for its SeaweedFS explicitly, so it needs none of them.
 */
describe("a bucket per Supatype bucket (S3_BUCKET unset)", () => {
  it("refuses to start with neither a region nor an endpoint, rather than use SeaweedFS on localhost", async () => {
    await expect(s3With({})).rejects.toThrow(/S3_REGION.*S3_ENDPOINT/)
  })

  it("takes credentials from the SDK's own chain at an endpoint with no keys, never the SeaweedFS login", async () => {
    const s3 = await s3With({ S3_ENDPOINT: "http://store:9000", AWS_ACCESS_KEY_ID: "ambient-id", AWS_SECRET_ACCESS_KEY: "ambient-secret" })
    expect((await s3.s3.config.credentials()).accessKeyId).toBe("ambient-id")
  })

  it("uses the settings compose passes for its SeaweedFS, path-style", async () => {
    const s3 = await s3With({
      S3_ENDPOINT: "http://seaweedfs:8333",
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY: "stack-key",
      S3_SECRET_KEY: "stack-secret",
      S3_FORCE_PATH_STYLE: "true",
    })
    const url = new URL(await s3.createSignedDownloadUrl("photos", "a.png", 60))
    expect(`${url.host}${url.pathname}`).toBe("seaweedfs:8333/photos/a.png")
    expect((await s3.s3.config.credentials()).accessKeyId).toBe("stack-key")
  })

  it("reads a blank S3_BUCKET as unset", async () => {
    const s3 = await s3With({ S3_BUCKET: " ", S3_ENDPOINT: "http://seaweedfs:8333", S3_ACCESS_KEY: "id", S3_SECRET_KEY: "secret" })
    const url = new URL(await s3.createSignedDownloadUrl("photos", "a.png", 60))
    expect(`${url.host}${url.pathname}`).toBe("seaweedfs:8333/photos/a.png")
  })

  it("names each S3 bucket with S3_BUCKET_PREFIX in front", async () => {
    const s3 = await s3With({ S3_BUCKET_PREFIX: "acme-prod-", S3_REGION: "eu-west-2", S3_ACCESS_KEY: "id", S3_SECRET_KEY: "secret" })
    const url = new URL(await s3.createSignedDownloadUrl("photos", "a.png", 60))
    expect(url.host).toBe("acme-prod-photos.s3.eu-west-2.amazonaws.com")
  })

  it("refuses to start with a prefix no S3 bucket name could begin with", async () => {
    await expect(s3With({ S3_BUCKET_PREFIX: "Acme_", S3_REGION: "eu-west-2" })).rejects.toThrow(/S3_BUCKET_PREFIX/)
  })

  it("refuses to start with S3_BUCKET_PREFIX beside S3_BUCKET, where there is one bucket to name", async () => {
    await expect(s3With({ S3_BUCKET: "shared", S3_BUCKET_PREFIX: "acme-", S3_REGION: "eu-west-2" })).rejects.toThrow(
      /S3_BUCKET_PREFIX.*S3_BUCKET/,
    )
  })

  it("says why a bucket id cannot name an S3 bucket once prefixed", async () => {
    const s3 = await s3With({ S3_BUCKET_PREFIX: "acme-", S3_REGION: "eu-west-2" })
    expect(s3.s3BucketNameProblem("photos")).toBeNull()
    expect(s3.s3BucketNameProblem("Team_Photos")).toMatch(/acme-Team_Photos/)
    expect(s3.s3BucketNameProblem("x".repeat(60))).toMatch(/63/)
  })

  it("leaves names alone at an endpoint with no prefix, which SeaweedFS stacks already hold", async () => {
    const s3 = await s3With({ S3_ENDPOINT: "http://seaweedfs:8333" })
    expect(s3.s3BucketNameProblem("Team_Photos")).toBeNull()
  })
})

describe("the file backend", () => {
  it("starts with no S3 settings at all, since it never talks to S3", async () => {
    await expect(s3With({ STORAGE_BACKEND: "file", STORAGE_FILE_PATH: "objects" })).resolves.toBeDefined()
  })
})
