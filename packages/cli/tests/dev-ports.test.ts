import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  ensureDevDbPort,
  findNextFreePort,
  isValidHostPort,
  parseHostPortInput,
  readPersistedKongPort,
} from "../src/dev-ports.js"
import { isPortInUse } from "../src/postgres-ctl.js"

vi.mock("../src/postgres-ctl.js", () => ({
  isPortInUse: vi.fn(),
}))

const isPortInUseMock = vi.mocked(isPortInUse)

describe("dev-ports", () => {
  beforeEach(() => {
    isPortInUseMock.mockReset()
  })

  it("validates host ports", () => {
    expect(isValidHostPort(18473)).toBe(true)
    expect(isValidHostPort(80)).toBe(false)
    expect(parseHostPortInput("18473")).toBe(18473)
    expect(parseHostPortInput("nope")).toBeNull()
  })

  it("reads persisted Kong port from .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-ports-"))
    writeFileSync(join(dir, ".env"), "SUPATYPE_KONG_PORT=18474\n", "utf8")
    expect(readPersistedKongPort(dir)).toBe(18474)
  })

  it("findNextFreePort skips taken ports", async () => {
    isPortInUseMock.mockImplementation(async (port) => port === 18473 || port === 18474)
    await expect(findNextFreePort(18473)).resolves.toBe(18475)
  })

  // Moving off a busy port rewrote DATABASE_URL with `supatype_admin:postgres@…/supatype`, the
  // credentials of a project that never set its own. `dev` happened to overwrite it again later in
  // the same start, so the bad value lived only until then, and only a run that stopped in between
  // kept it.
  it("moving off a busy database port keeps the project's own credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-ports-"))
    writeFileSync(
      join(dir, ".env"),
      [
        "POSTGRES_USER=supatype_admin",
        "POSTGRES_PASSWORD=ks-own-password",
        "POSTGRES_DB=kitchen-sink",
        "SUPATYPE_DEV_DB_PORT=54329",
        "",
      ].join("\n"),
      "utf8",
    )
    isPortInUseMock.mockImplementation(async (port) => port === 54329)

    await expect(ensureDevDbPort(dir)).resolves.toBe(54330)

    const env = readFileSync(join(dir, ".env"), "utf8")
    expect(env).toMatch(/^SUPATYPE_DEV_DB_PORT=54330$/m)
    expect(env).toMatch(
      /^DATABASE_URL=postgresql:\/\/supatype_admin:ks-own-password@127\.0\.0\.1:54330\/kitchen-sink\?sslmode=disable$/m,
    )
  })
})
