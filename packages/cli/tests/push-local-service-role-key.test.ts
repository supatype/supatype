import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { localServiceRoleKey } from "../src/commands/push.js"
import { configuredServiceRoleKey, shellServiceRoleKey } from "../src/dev-api-keys.js"
import { signJwt, verifyJwt } from "../src/jwt.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * `push` on a native dev stack signed its service-role key with the published dev secret, while
 * native dev runs with the project's own JWT_SECRET from `.env` (generated there when missing).
 * The stack refused the key with 401, so storage buckets were never provisioned.
 */
const SECRET = "a-project-secret-that-is-at-least-32-characters"
const published = "super-secret-jwt-token-with-at-least-32-characters-long"

const nativeConfig: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "native" },
  server: { mode: "dev" },
  app: { mode: "none" },
}

let dir = ""
let originalCwd = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-push-key-"))
  originalCwd = process.cwd()
  process.chdir(dir)
  vi.stubEnv("SUPATYPE_SERVICE_ROLE_KEY", undefined)
  vi.stubEnv("SERVICE_ROLE_KEY", undefined)
})

afterEach(() => {
  process.chdir(originalCwd)
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe("the service-role key push uses on a native dev stack", () => {
  it("is signed with the project's JWT_SECRET, not the published one", () => {
    writeFileSync(join(dir, ".env"), `JWT_SECRET=${SECRET}\n`)
    const key = localServiceRoleKey(nativeConfig) ?? ""
    expect(verifyJwt(key, SECRET)?.["role"]).toBe("service_role")
    expect(verifyJwt(key, published)).toBeNull()
  })
})

describe("a service-role key exported in the shell", () => {
  // Compose runs without the shell's SERVICE_ROLE_KEY once .env holds a JWT_SECRET, so a shell key
  // signed with another secret is one the stack refuses.
  const shellKey = signJwt({ iss: "supatype", role: "service_role" }, published)

  it("is passed over for .env's once .env holds the secret the stack runs with", () => {
    vi.stubEnv("SERVICE_ROLE_KEY", shellKey)
    writeFileSync(join(dir, ".env"), `JWT_SECRET=${SECRET}\n`)
    const key = localServiceRoleKey(nativeConfig) ?? ""
    expect(verifyJwt(key, SECRET)?.["role"]).toBe("service_role")
    expect(shellServiceRoleKey(dir)).toBeUndefined()
  })

  it("is sent when it is signed with .env's secret and .env's own key is blank", () => {
    const good = signJwt({ iss: "supatype", role: "service_role" }, SECRET)
    vi.stubEnv("SERVICE_ROLE_KEY", good)
    writeFileSync(join(dir, ".env"), `JWT_SECRET=${SECRET}\nSERVICE_ROLE_KEY=\n`)
    expect(shellServiceRoleKey(dir)).toBe(good)
    // The control plane and REST cache callers read the configured key: the one compose kept.
    expect(configuredServiceRoleKey(dir)).toBe(good)
  })

  it("gives way to .env's SERVICE_ROLE_KEY, the name the stack runs with, not SUPATYPE_SERVICE_ROLE_KEY", () => {
    vi.stubEnv("SERVICE_ROLE_KEY", shellKey)
    writeFileSync(
      join(dir, ".env"),
      `JWT_SECRET=${SECRET}\nSERVICE_ROLE_KEY=the-stack-key\nSUPATYPE_SERVICE_ROLE_KEY=a-stale-key\n`,
    )
    expect(shellServiceRoleKey(dir)).toBe("the-stack-key")
  })

  it("is the one sent while .env holds no secret, since compose then passes it to the stack", () => {
    vi.stubEnv("SERVICE_ROLE_KEY", shellKey)
    writeFileSync(join(dir, ".env"), "")
    expect(localServiceRoleKey(nativeConfig)).toBe(shellKey)
  })

  it("is taken as given under SUPATYPE_SERVICE_ROLE_KEY, which compose never reads", () => {
    vi.stubEnv("SUPATYPE_SERVICE_ROLE_KEY", "the-cli-own-key")
    writeFileSync(join(dir, ".env"), `JWT_SECRET=${SECRET}\n`)
    expect(localServiceRoleKey(nativeConfig)).toBe("the-cli-own-key")
  })
})
