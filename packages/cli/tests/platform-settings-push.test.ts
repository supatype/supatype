import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TargetApiError, type TargetFetchOptions } from "../src/target-client.js"
import type { DeployTarget } from "../src/resolve-target.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

// The platform step of a push to Cloud: what is sent where, what is skipped, and how a failure is
// reported. The control plane is a recorder.

const calls: TargetFetchOptions[] = []
let answers: Array<unknown | Error> = []

vi.mock("../src/target-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/target-client.js")>()),
  targetFetch: async (_base: string, _prefix: string, opts: TargetFetchOptions) => {
    calls.push(opts)
    const next = answers.shift()
    if (next instanceof Error) throw next
    return next ?? {}
  },
}))

const { pushPlatformSettings } = await import("../src/platform-settings-push.js")

const cloud: DeployTarget = { mode: "cloud", environment: "production", projectRef: "abc", apiBaseUrl: "https://api.example.test", apiPrefix: "/api/v1", token: "t", link: null }
const ENV = { ACME_S3_KEY: "AKIAEXAMPLE0001", ACME_S3_SECRET: "s3cr3tvalue" }

const config = (extra: Record<string, unknown> = {}): SupatypeProjectConfig =>
  validateProjectConfig(
    { project: { name: "acme" }, server: { mode: "standalone" }, app: { mode: "none" }, database: { provider: "docker" }, versions: { postgres: "17.2", deno: DENO_RELEASE_PIN }, ...extra },
    "supatype.config.ts",
  )

const BUCKET_CONFIG = {
  storage: { provider: "s3", production: "s3", s3: { bucket: "acme-files", region: "eu-west-1", accessKey: "env(ACME_S3_KEY)", secretKey: "env(ACME_S3_SECRET)" } },
}

let said: string[] = []

beforeEach(() => {
  calls.length = 0
  answers = []
  said = []
  process.exitCode = undefined
  for (const stream of ["log", "error", "warn"] as const) vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe("a push to Cloud", () => {
  it("sends nothing for a project that uses none of the settings, so it is pushed as before", async () => {
    expect(await pushPlatformSettings(process.cwd(), config(), cloud, { environment: ENV })).toBe(false)
    expect(calls).toEqual([])
  })

  it("sends services and realtime to the platform-settings route", async () => {
    const failed = await pushPlatformSettings(process.cwd(), config({ services: { storage: false }, realtime: { channels: "declared", recheckSeconds: 60 } }), cloud, { environment: ENV })
    expect(failed).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: "/projects/abc/platform-settings",
      body: { services: { storage: false }, realtime: { channels: "declared", recheckSeconds: 60 } },
    })
  })

  it("sends the bucket with its keys resolved from the environment, and says files are not moved", async () => {
    answers = [{ own: false, bucket: null }, { own: true }]
    const failed = await pushPlatformSettings(process.cwd(), config(BUCKET_CONFIG), cloud, { environment: ENV })
    expect(failed).toBe(false)
    const put = calls.find((c) => c.method === "PUT")
    expect(put).toMatchObject({
      path: "/projects/abc/storage-bucket",
      body: { bucket: "acme-files", region: "eu-west-1", accessKey: "AKIAEXAMPLE0001", secretKey: "s3cr3tvalue" },
    })
    expect(said.join("\n")).toContain("Files already stored are not moved")
  })

  it("does not repeat the warning when the bucket is the one it already had", async () => {
    answers = [{ own: true, bucket: { bucket: "acme-files" } }, { own: true, unchanged: true }]
    await pushPlatformSettings(process.cwd(), config(BUCKET_CONFIG), cloud, { environment: ENV })
    expect(said.join("\n")).not.toContain("not moved")
    expect(said.join("\n")).toContain("unchanged")
  })

  it("names a key it does not have, sends no bucket, and ends the push as failed", async () => {
    const failed = await pushPlatformSettings(process.cwd(), config(BUCKET_CONFIG), cloud, { environment: { ACME_S3_KEY: "AKIAEXAMPLE0001" } })
    expect(failed).toBe(true)
    expect(calls.filter((c) => c.method === "PUT")).toEqual([])
    expect(process.exitCode).toBe(1)
    expect(said.join("\n")).toContain("ACME_S3_SECRET is not set here")
  })

  it("never prints a key, even when the control plane echoes one", async () => {
    answers = [{ own: false }, new TargetApiError("rejected key s3cr3tvalue for AKIAEXAMPLE0001", 400)]
    const failed = await pushPlatformSettings(process.cwd(), config(BUCKET_CONFIG), cloud, { environment: ENV })
    expect(failed).toBe(true)
    expect(said.join("\n")).not.toContain("s3cr3tvalue")
    expect(said.join("\n")).not.toContain("AKIAEXAMPLE0001")
    expect(process.exitCode).toBe(1)
  })

  it("says who may change the bucket when a developer is refused", async () => {
    answers = [{ own: false }, new TargetApiError("Only the organisation's owners and admins can change where a project keeps its files", 403)]
    await pushPlatformSettings(process.cwd(), config(BUCKET_CONFIG), cloud, { environment: ENV })
    expect(said.join("\n")).toContain("owners and admins")
  })

  it("reports a settings failure and still sends the bucket", async () => {
    answers = [new Error("route not found")]
    const failed = await pushPlatformSettings(process.cwd(), config({ ...BUCKET_CONFIG, services: { graphql: false } }), cloud, { environment: ENV })
    expect(failed).toBe(true)
    expect(said.join("\n")).toContain("The schema was applied, but the platform settings")
    expect(calls.map((c) => c.method)).toEqual(["PUT", "GET", "PUT"])
  })

  it("applies to production only, and says so for another environment", async () => {
    const failed = await pushPlatformSettings(process.cwd(), config({ services: { storage: false } }), { ...cloud, environment: "staging" }, { environment: ENV })
    expect(failed).toBe(false)
    expect(calls).toEqual([])
    expect(said.join("\n")).toContain("apply to production only")
  })

  it("sends nothing to a self-host target, which reads the same settings from its compose file", async () => {
    const failed = await pushPlatformSettings(process.cwd(), config({ services: { storage: false }, ...BUCKET_CONFIG }), { ...cloud, mode: "self-host" }, { environment: ENV })
    expect(failed).toBe(false)
    expect(calls).toEqual([])
  })
})
