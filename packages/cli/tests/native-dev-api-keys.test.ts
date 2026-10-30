import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { signJwt } from "../src/jwt.js"
import { nativeDevApiKeys } from "../src/native-dev-env.js"
import { devServiceRoleKeyPath } from "../src/service-role-key-file.js"

/**
 * Local test round 3 N5: native dev signed a fresh key pair every run, so the SERVICE_ROLE_KEY in
 * `.env` was refused by the admin API (`401 service role key required`), which compares the key as
 * a string. Native dev now starts the server with the keys `.env` holds while they verify, as
 * Docker dev does.
 */
const SECRET = "a-project-secret-that-is-at-least-32-characters"
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-native-keys-"))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("nativeDevApiKeys", () => {
  it("starts the server with the keys .env holds, and writes that service-role key for the worker", () => {
    const anon = signJwt({ iss: "supatype", role: "anon", iat: 1, exp: 4_000_000_000 }, SECRET)
    const service = signJwt({ iss: "supatype", role: "service_role", iat: 1, exp: 4_000_000_000 }, SECRET)
    writeFileSync(join(dir, ".env"), `JWT_SECRET=${SECRET}\nANON_KEY=${anon}\nSERVICE_ROLE_KEY=${service}\n`, "utf8")

    expect(nativeDevApiKeys(dir)).toEqual({ anonKey: anon, serviceRoleKey: service })
    const keyPath = devServiceRoleKeyPath(dir)
    expect(existsSync(keyPath) && readFileSync(keyPath, "utf8").trim()).toBe(service)
  })
})
