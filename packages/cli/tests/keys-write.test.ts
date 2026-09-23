/**
 * `supatype keys` writes the pair it mints.
 *
 * It printed and wrote nothing, while every example README says it mints the keys into .env.
 * Following the docs therefore produced a front end built with `anonKey: undefined`, which the
 * gateway refuses on every request with nothing in the output explaining why.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeKeysToEnv } from "../src/commands/keys.js"

const PAIR = { anonKey: "anon.jwt.value", serviceKey: "service.jwt.value" }

function envValue(dir: string, key: string): string | undefined {
  const line = readFileSync(join(dir, ".env"), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`))
  return line?.slice(key.length + 1).trim()
}

describe("writeKeysToEnv", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-keys-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("fills blank canonical keys", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=s\nANON_KEY=\nSERVICE_ROLE_KEY=\n")
    const result = writeKeysToEnv(dir, PAIR, false)

    expect(result.names).toEqual(["ANON_KEY", "SERVICE_ROLE_KEY"])
    expect(envValue(dir, "ANON_KEY")).toBe(PAIR.anonKey)
    expect(envValue(dir, "SERVICE_ROLE_KEY")).toBe(PAIR.serviceKey)
  })

  it("adds canonical keys that are absent entirely", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=s\n")
    writeKeysToEnv(dir, PAIR, false)

    expect(envValue(dir, "ANON_KEY")).toBe(PAIR.anonKey)
    expect(envValue(dir, "SERVICE_ROLE_KEY")).toBe(PAIR.serviceKey)
  })

  // The defect the kitchen sink hit: declared and blank reads as undefined, so a presence test
  // written against readEnvVar skips exactly the line it should fill, and the SPA builds keyless.
  it("fills a declared-but-blank front end alias", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=s\nANON_KEY=\nVITE_SUPATYPE_ANON_KEY=\n")
    const result = writeKeysToEnv(dir, PAIR, false)

    expect(result.names).toContain("VITE_SUPATYPE_ANON_KEY")
    expect(envValue(dir, "VITE_SUPATYPE_ANON_KEY")).toBe(PAIR.anonKey)
  })

  it("does not add an alias the project never declared", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=s\nANON_KEY=\n")
    writeKeysToEnv(dir, PAIR, false)

    const content = readFileSync(join(dir, ".env"), "utf8")
    expect(content).not.toContain("EXPO_PUBLIC_SUPATYPE_ANON_KEY")
    expect(content).not.toContain("PUBLIC_SUPATYPE_ANON_KEY")
  })

  it("leaves a key that already holds a value, and says so", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=s\nANON_KEY=in-use-by-clients\nSERVICE_ROLE_KEY=\n")
    const result = writeKeysToEnv(dir, PAIR, false)

    expect(result.skipped).toEqual(["ANON_KEY"])
    expect(result.names).toEqual(["SERVICE_ROLE_KEY"])
    expect(envValue(dir, "ANON_KEY")).toBe("in-use-by-clients")
  })

  it("replaces a set key only under --force", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=s\nANON_KEY=in-use-by-clients\n")
    const result = writeKeysToEnv(dir, PAIR, true)

    expect(result.skipped).toEqual([])
    expect(envValue(dir, "ANON_KEY")).toBe(PAIR.anonKey)
  })

  it("reports no .env rather than creating one", () => {
    const result = writeKeysToEnv(dir, PAIR, false)

    expect(result.path).toBeNull()
    expect(result.names).toEqual([])
  })
})
