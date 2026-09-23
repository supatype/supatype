import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
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
})
