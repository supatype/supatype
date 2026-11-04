import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ensureKongPort, persistKongPort } from "../src/dev-ports.js"
import { readEnvFile } from "../src/env-file.js"
import { isPortInUse } from "../src/postgres-ctl.js"

vi.mock("../src/postgres-ctl.js", () => ({
  isPortInUse: vi.fn(),
}))

const isPortInUseMock = vi.mocked(isPortInUse)

beforeEach(() => {
  isPortInUseMock.mockReset()
})

// The shell's port is the one Compose binds, so offering to move to another would write a port to
// `.env` that Compose then ignores. It has to stop, and say the shell is where the port came from.
describe("a Kong port set in the shell", () => {
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

  it("that is busy exits without prompting, even in a terminal, and names the shell", async () => {
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

/**
 * Issue 23: a Kong port moved by dev was written to `.env` as `PUBLIC_SUPATYPE_URL` too, which a
 * production build reads. The front-end names go to `.env.development.local`.
 */
describe("a Kong port dev moves to", () => {
  it("is recorded in .env, with the front end's copies in .env.development.local", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-ports-"))
    writeFileSync(join(dir, ".env"), "SUPATYPE_KONG_PORT=18474\nPUBLIC_SUPATYPE_URL=http://localhost:18474\n", "utf8")
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    persistKongPort(dir, 18490)
    const env = readEnvFile(dir)
    expect(env["SUPATYPE_KONG_PORT"]).toBe("18490")
    expect(env["API_EXTERNAL_URL"]).toBe("http://localhost:18490")
    // The old port's copy is a local address the CLI wrote, so it goes too.
    expect(env["PUBLIC_SUPATYPE_URL"]).toBeUndefined()
    expect(readEnvFile(dir, ".env.development.local")["PUBLIC_SUPATYPE_URL"]).toBe("http://localhost:18490")
    vi.restoreAllMocks()
  })
})
