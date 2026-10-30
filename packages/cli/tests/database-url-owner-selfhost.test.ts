import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { syncDatabaseUrlPort } from "../src/database-url-owner.js"
import { MANAGED_MARKER } from "../src/env-file.js"

/**
 * N1, self-host half: `self-host compose up` moved DATABASE_URL's port to SUPATYPE_DB_PORT whoever
 * had written the URL, so an operator's own URL, typically their external database on this machine,
 * was repointed at the stack. It now follows the dev rule: only a URL the CLI wrote is moved.
 */
let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-db-url-selfhost-"))
  for (const key of ["DATABASE_URL", "SUPATYPE_DB_PORT", "SUPATYPE_DEV_DB_PORT"]) vi.stubEnv(key, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function writeEnv(lines: string[]): void {
  writeFileSync(join(dir, ".env"), [...lines, "POSTGRES_PASSWORD=pw", "POSTGRES_DB=acme", "SUPATYPE_DB_PORT=5433", ""].join("\n"), "utf8")
}

const envUrl = (): string | undefined => /^DATABASE_URL=(.*)$/m.exec(readFileSync(join(dir, ".env"), "utf8"))?.[1]

describe("syncDatabaseUrlPort for a self-host stack", () => {
  it("leaves a hand-written URL on its own port", () => {
    writeEnv(["DATABASE_URL=postgresql://ops:secret@localhost:5432/prod"])
    expect(syncDatabaseUrlPort(dir, false)).toBeNull()
    expect(envUrl()).toBe("postgresql://ops:secret@localhost:5432/prod")
  })

  it("moves a URL the CLI wrote to SUPATYPE_DB_PORT", () => {
    writeEnv([MANAGED_MARKER, "DATABASE_URL=postgresql://supatype_admin:pw@localhost:5432/acme"])
    expect(syncDatabaseUrlPort(dir, false)).toEqual({ from: "5432", to: "5433", envKey: "SUPATYPE_DB_PORT" })
    expect(envUrl()).toBe("postgresql://supatype_admin:pw@localhost:5433/acme")
  })

  it("moves an unmarked URL in the shape init writes", () => {
    writeEnv(["DATABASE_URL=postgresql://supatype_admin:pw@localhost:5432/acme"])
    syncDatabaseUrlPort(dir, false)
    expect(envUrl()).toBe("postgresql://supatype_admin:pw@localhost:5433/acme")
  })
})
