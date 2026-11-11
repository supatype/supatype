import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { defaultScaffoldOptions, initSecretLines, scaffold } from "../src/commands/init.js"

/**
 * Fresh-user test C8: the self-host stack reads SUPATYPE_DB_PORT, SUPATYPE_SERVER_PORT and
 * SUPATYPE_SEAWEEDFS_PORT, and nothing a new project gets named them, so the first anyone heard of
 * them was a clash on 5432. The generated `.env` lists each with its default and says how to expose
 * them, commented out so the defaults still apply.
 */
let dir: string

beforeEach(() => {
  dir = join(tmpdir(), `dt-init-selfhost-env-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("init .env self-host ports", () => {
  it("lists every self-host port variable and the publish address, commented out", () => {
    scaffold(dir, defaultScaffoldOptions("ports-app"))
    const env = readFileSync(join(dir, ".env"), "utf8")
    expect(env).toMatch(/^# SUPATYPE_PUBLISH_ADDRESS=127\.0\.0\.1$/m)
    expect(env).toMatch(/^# SUPATYPE_DB_PORT=5432$/m)
    expect(env).toMatch(/^# SUPATYPE_SERVER_PORT=9999$/m)
    expect(env).toMatch(/^# SUPATYPE_SEAWEEDFS_PORT=8333$/m)
    expect(env).toContain("0.0.0.0")
  })

  // 0.9.2 release test round 2 (N-S26): a stack on the project's own S3 bucket runs no SeaweedFS,
  // and its .env still named one and the port it would publish.
  it("names no SeaweedFS for a stack whose production storage is S3", () => {
    scaffold(dir, { ...defaultScaffoldOptions("ports-app"), storageProduction: "s3" })
    const ports = readFileSync(join(dir, ".env"), "utf8").split("# Self-host stack ports")[1] ?? ""
    expect(ports).toMatch(/^# SUPATYPE_SERVER_PORT=9999$/m)
    expect(ports).not.toContain("SeaweedFS")
    expect(ports).not.toContain("SUPATYPE_SEAWEEDFS_PORT")
  })
})

/**
 * 0.9.2 release test round 2 (R2-S14): dev wrote SUPATYPE_KEYSPACE_PASSWORD to the end of .env with
 * nothing to say what it was, while every other secret init generates has a comment above it.
 */
describe("init .env keyspace password", () => {
  it("is generated with a comment saying what it opens", () => {
    scaffold(dir, defaultScaffoldOptions("ks-app"))
    const env = readFileSync(join(dir, ".env"), "utf8")
    const line = /^# .*\n(?:# .*\n)*SUPATYPE_KEYSPACE_PASSWORD=([A-Za-z0-9_-]{32})$/m.exec(env)
    expect(line, "a commented, generated SUPATYPE_KEYSPACE_PASSWORD").not.toBeNull()
    expect(line![0]).toContain("keyspace")
  })

  // 0.9.2 round 2 (R2-S16): with the password in a file the shell names, a generated one beside it
  // makes the stack refuse to start, so init writes none and says where the password comes from.
  it("is not generated when the shell names a file for it", () => {
    vi.stubEnv("SUPATYPE_KEYSPACE_PASSWORD_FILE", "/run/secrets/keyspace")
    try {
      scaffold(dir, defaultScaffoldOptions("ks-app"))
      const env = readFileSync(join(dir, ".env"), "utf8")
      expect(env).not.toMatch(/^SUPATYPE_KEYSPACE_PASSWORD=/m)
      expect(env).toMatch(/^# .*SUPATYPE_KEYSPACE_PASSWORD_FILE/m)
      expect(initSecretLines().join("\n")).not.toContain("SUPATYPE_KEYSPACE_PASSWORD")
    } finally {
      vi.unstubAllEnvs()
    }
    expect(initSecretLines().join("\n")).toContain("SUPATYPE_KEYSPACE_PASSWORD")
  })
})
