import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { localServiceRoleKey } from "../src/commands/push.js"
import { verifyJwt } from "../src/jwt.js"
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
