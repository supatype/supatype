import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { devApiKeys } from "../src/dev-api-keys.js"
import { signJwt, verifyJwt } from "../src/jwt.js"

/**
 * Every compose command used to sign a fresh anon and service-role key (a new `iat`) and write
 * them to `.env`. The services that read them were then recreated by the next `compose up -d`, and
 * clients holding the old anon key were handed a new one for no reason. Keys that still verify
 * against the project's secret are kept.
 */
const SECRET = "a-project-secret-that-is-at-least-32-characters"
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-dev-keys-"))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function env(lines: string[]): void {
  writeFileSync(join(dir, ".env"), `${lines.join("\n")}\n`, "utf8")
}

describe("devApiKeys", () => {
  it("keeps keys in .env that verify against the project's secret", () => {
    const anon = signJwt({ iss: "supatype", role: "anon", iat: 1, exp: 4_000_000_000 }, SECRET)
    const service = signJwt({ iss: "supatype", role: "service_role", iat: 1, exp: 4_000_000_000 }, SECRET)
    env([`JWT_SECRET=${SECRET}`, `ANON_KEY=${anon}`, `SERVICE_ROLE_KEY=${service}`])
    expect(devApiKeys(dir)).toEqual({ anonKey: anon, serviceRoleKey: service })
  })

  it("signs new keys when the secret changed", () => {
    const anon = signJwt({ iss: "supatype", role: "anon", iat: 1, exp: 4_000_000_000 }, "an-old-secret-that-is-also-32-characters-long")
    env([`JWT_SECRET=${SECRET}`, `ANON_KEY=${anon}`])
    const keys = devApiKeys(dir)
    expect(keys.anonKey).not.toBe(anon)
    expect(verifyJwt(keys.anonKey, SECRET)).toMatchObject({ role: "anon", iss: "supatype" })
    expect(verifyJwt(keys.serviceRoleKey, SECRET)).toMatchObject({ role: "service_role" })
  })

  it("signs new keys when a key names the wrong role or has expired", () => {
    const swapped = signJwt({ iss: "supatype", role: "service_role", iat: 1, exp: 4_000_000_000 }, SECRET)
    const expired = signJwt({ iss: "supatype", role: "service_role", iat: 1, exp: 2 }, SECRET)
    env([`JWT_SECRET=${SECRET}`, `ANON_KEY=${swapped}`, `SERVICE_ROLE_KEY=${expired}`])
    const keys = devApiKeys(dir)
    expect(keys.anonKey).not.toBe(swapped)
    expect(keys.serviceRoleKey).not.toBe(expired)
  })

  it("gives the same keys on every call", () => {
    env([`JWT_SECRET=${SECRET}`])
    const first = devApiKeys(dir)
    writeFileSync(join(dir, ".env"), `JWT_SECRET=${SECRET}\nANON_KEY=${first.anonKey}\nSERVICE_ROLE_KEY=${first.serviceRoleKey}\n`)
    expect(devApiKeys(dir)).toEqual(first)
  })
})

describe("verifyJwt", () => {
  it("refuses a token signed with another secret, or altered", () => {
    const token = signJwt({ role: "anon" }, SECRET)
    expect(verifyJwt(token, SECRET)).toEqual({ role: "anon" })
    expect(verifyJwt(token, `${SECRET}x`)).toBeNull()
    expect(verifyJwt(`${token}x`, SECRET)).toBeNull()
    expect(verifyJwt("not.a.jwt", SECRET)).toBeNull()
  })
})
