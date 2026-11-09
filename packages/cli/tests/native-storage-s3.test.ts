/**
 * Native dev for a project with `storage.provider: "s3"` (0.9.2).
 *
 * No storage service used to start for such a project, so the server proxied /storage/v1 to
 * localhost:5000, where nothing listened, and every storage call failed. Native dev now runs the
 * storage service on the project's own S3 bucket, every Supatype bucket a prefix in it, with the
 * S3 settings init wrote into .env. A blank S3_BUCKET is refused by name rather than started against
 * defaults that point at a SeaweedFS that is not there, and a SUPATYPE_STORAGE_URL of the
 * developer's own still wins.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isJsonObject } from "@supatype/shared"
import { nativeS3StorageEnv, startNativeS3Storage, type NativeStorageOptions } from "../src/native-storage.js"
import { parseJsonAs } from "./support/json.js"
import { freePort } from "./support/ports.js"
import { projectConfig } from "./support/project-config.js"

let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-native-storage-s3-"))
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const S3_ENV = {
  S3_BUCKET: "my-app-dev",
  S3_REGION: "eu-west-2",
  S3_ENDPOINT: "",
  S3_ACCESS_KEY: "AKIAEXAMPLE",
  S3_SECRET_KEY: "example-secret",
}

describe("the storage service's environment for a project on S3", () => {
  it("refuses a blank S3_BUCKET by name, as init scaffolds it", () => {
    expect(() => nativeS3StorageEnv({ ...S3_ENV, S3_BUCKET: "" })).toThrow(/S3_BUCKET/)
    expect(() => nativeS3StorageEnv({})).toThrow(/S3_BUCKET/)
  })

  it("is not needed when SUPATYPE_STORAGE_URL names the developer's own service", () => {
    expect(nativeS3StorageEnv({ SUPATYPE_STORAGE_URL: "http://127.0.0.1:9000" })).toBeNull()
  })

  it("hands the service every S3 setting from .env, blank ones blank, and the S3 backend", () => {
    expect(nativeS3StorageEnv({ ...S3_ENV, S3_FORCE_PATH_STYLE: "true" })).toEqual({
      STORAGE_BACKEND: "s3",
      S3_BUCKET: "my-app-dev",
      S3_REGION: "eu-west-2",
      S3_ENDPOINT: "",
      S3_ACCESS_KEY: "AKIAEXAMPLE",
      S3_SECRET_KEY: "example-secret",
      S3_FORCE_PATH_STYLE: "true",
      S3_PUBLIC_URL: "",
    })
  })
})

function options(port: number): NativeStorageOptions {
  return {
    config: projectConfig({ storage: { provider: "s3" } }),
    cwd: dir,
    manifestPath: join(dir, "routes.json"),
    pidDir: dir,
    stateRoot: join(dir, "state"),
    port,
    databaseUrl: "postgres://localhost/none",
    jwtSecret: "secret",
  }
}

/** A launch that writes the environment it was given to `envFile`, then answers /health on `port`. */
function recordingLaunch(port: number, envFile: string): { bin: string; args: string[] } {
  const script = [
    `require("node:fs").writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env))`,
    `require("node:http").createServer((q, s) => { s.writeHead(200); s.end('{"status":"ok"}') }).listen(${port}, "127.0.0.1")`,
  ].join(";")
  return { bin: process.execPath, args: ["-e", script] }
}

describe("startNativeS3Storage", () => {
  it("starts the service on the project's bucket and names it in the route manifest", async () => {
    const port = await freePort()
    const envFile = join(dir, "env.json")
    const s3Env = nativeS3StorageEnv(S3_ENV)
    if (s3Env === null) throw new Error("expected the service's environment")
    const storage = await startNativeS3Storage(options(port), s3Env, async () => recordingLaunch(port, envFile))
    try {
      expect(storage.url).toBe(`http://127.0.0.1:${port}`)
      const manifest = parseJsonAs(readFileSync(join(dir, "routes.json"), "utf8"), isJsonObject)
      expect(manifest["storage_url"]).toBe(`http://127.0.0.1:${port}`)
      const env = parseJsonAs(readFileSync(envFile, "utf8"), isJsonObject)
      expect(env).toMatchObject({ STORAGE_BACKEND: "s3", S3_BUCKET: "my-app-dev", S3_REGION: "eu-west-2", PORT: String(port) })
      expect(env["STORAGE_FILE_PATH"]).toBeUndefined()
    } finally {
      await storage.proc.stop()
    }
  }, 30_000)

  it("fails, naming the bucket, when the service exits before it is ready", async () => {
    const s3Env = nativeS3StorageEnv(S3_ENV)
    if (s3Env === null) throw new Error("expected the service's environment")
    const crashing = { bin: process.execPath, args: ["-e", "process.exit(3)"] }
    await expect(startNativeS3Storage(options(await freePort()), s3Env, async () => crashing)).rejects.toThrow(/my-app-dev/)
  }, 20_000)
})
