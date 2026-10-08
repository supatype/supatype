import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  ensureKongPort,
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
    expect(readPersistedKongPort(dir, {})).toBe(18474)
  })

  // Compose binds the environment's port over `.env`'s, so `dev` must wait on the same one.
  it("takes the environment's port over .env's, as Docker Compose does", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-ports-"))
    writeFileSync(join(dir, ".env"), "SUPATYPE_KONG_PORT=18474\n", "utf8")
    expect(readPersistedKongPort(dir, { SUPATYPE_KONG_PORT: "18490" })).toBe(18490)
    expect(readPersistedKongPort(dir, { SUPATYPE_KONG_PORT: "not a port" })).toBe(18474)
  })

  it("findNextFreePort skips taken ports", async () => {
    isPortInUseMock.mockImplementation(async (port) => port === 18473 || port === 18474)
    await expect(findNextFreePort(18473)).resolves.toBe(18475)
  })

  // The shell's port is the one Compose binds, so offering to move to another would write a port to
  // `.env` that Compose then ignores. It has to stop, and say the shell is where the port came from.
  describe("when the shell's SUPATYPE_KONG_PORT is busy", () => {
    let exit: ReturnType<typeof vi.spyOn>
    let printed: string[]

    beforeEach(() => {
      printed = []
      const capture = (...args: unknown[]) => {
        printed.push(args.map(String).join(" "))
      }
      vi.spyOn(console, "log").mockImplementation(capture)
      vi.spyOn(console, "error").mockImplementation(capture)
      exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`)
      }) as typeof process.exit)
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it("exits without prompting, even in a terminal, and names the shell", async () => {
      const dir = mkdtempSync(join(tmpdir(), "supatype-ports-"))
      writeFileSync(join(dir, ".env"), "SUPATYPE_KONG_PORT=18474\n", "utf8")
      isPortInUseMock.mockImplementation(async (port) => port === 18490)

      await expect(
        ensureKongPort(dir, { interactive: true, env: { SUPATYPE_KONG_PORT: "18490" } }),
      ).rejects.toThrow("exit 1")

      expect(exit).toHaveBeenCalledWith(1)
      const out = printed.join("\n")
      expect(out).toContain("SUPATYPE_KONG_PORT=18490 is set in your shell")
      expect(out).toContain("unset SUPATYPE_KONG_PORT")
      expect(readFileSync(join(dir, ".env"), "utf8")).toBe("SUPATYPE_KONG_PORT=18474\n")
    })

    it("uses the shell's port when it is free", async () => {
      const dir = mkdtempSync(join(tmpdir(), "supatype-ports-"))
      isPortInUseMock.mockResolvedValue(false)
      await expect(
        ensureKongPort(dir, { interactive: true, env: { SUPATYPE_KONG_PORT: "18490" } }),
      ).resolves.toBe(18490)
    })
  })
})
