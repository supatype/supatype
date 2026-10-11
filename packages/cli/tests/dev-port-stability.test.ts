import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * A3-N2, A5-N5: with `supatype dev` running, every `push` and even a read-only `doctor` found the
 * project's own database on SUPATYPE_DEV_DB_PORT, moved to the next port, rewrote `.env` and
 * recreated the database (54531, 54532, 54533...). Kong then answered 502 on auth, realtime lost its
 * database, and the control plane crashed.
 */

const dockerPs = vi.hoisted(() => ({ owner: "" }))
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (cmd: string, args: readonly string[]) =>
    cmd === "docker" && args[0] === "ps"
      ? { status: 0, stdout: dockerPs.owner, stderr: "" }
      : { status: 1, stdout: "", stderr: "unexpected spawn" },
}))
vi.mock("../src/postgres-ctl.js", () => ({ isPortInUse: vi.fn() }))

const { ensureDevDbPort, readPersistedKongPort } = await import("../src/dev-ports.js")
const { upsertEnvFile } = await import("../src/env-file.js")
const { isPortInUse } = await import("../src/postgres-ctl.js")
const isPortInUseMock = vi.mocked(isPortInUse)

let dir: string
const ENV = ["POSTGRES_USER=supatype_admin", "POSTGRES_PASSWORD=pw", "POSTGRES_DB=demo", "SUPATYPE_DEV_DB_PORT=54561", ""].join("\n")

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-port-stability-"))
  writeFileSync(join(dir, ".env"), ENV, "utf8")
  isPortInUseMock.mockReset()
  dockerPs.owner = ""
  delete process.env["SUPATYPE_KONG_PORT"]
  delete process.env["SUPATYPE_DEV_DB_PORT"]
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env["SUPATYPE_KONG_PORT"]
  delete process.env["SUPATYPE_DEV_DB_PORT"]
})

describe("the dev database port", () => {
  it("is kept when the project's own database holds it", async () => {
    isPortInUseMock.mockImplementation(async (port) => port === 54561)
    dockerPs.owner = "supatype-demo\n"
    await expect(ensureDevDbPort(dir, { composeProject: "supatype-demo" })).resolves.toBe(54561)
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ENV)
  })

  it("is never moved by a command that is not dev, even when a stranger holds it", async () => {
    isPortInUseMock.mockImplementation(async (port) => port === 54561)
    dockerPs.owner = "someone-else\n"
    await expect(ensureDevDbPort(dir, { composeProject: "supatype-demo" })).rejects.toThrow(/54561.*in use/)
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ENV)
  })

  it("is moved by dev when a stranger holds it", async () => {
    isPortInUseMock.mockImplementation(async (port) => port === 54561)
    dockerPs.owner = "someone-else\n"
    await expect(ensureDevDbPort(dir, { composeProject: "supatype-demo", mayMove: true })).resolves.toBe(54562)
    expect(readFileSync(join(dir, ".env"), "utf8")).toMatch(/^SUPATYPE_DEV_DB_PORT=54562$/m)
  })

  it("comes from the shell first, as compose binds it", async () => {
    process.env["SUPATYPE_DEV_DB_PORT"] = "54880"
    isPortInUseMock.mockResolvedValue(false)
    await expect(ensureDevDbPort(dir, { composeProject: "supatype-demo" })).resolves.toBe(54880)
  })
})

describe("the Kong port", () => {
  // Compose binds an exported SUPATYPE_KONG_PORT over `.env`, while dev and push waited for Kong on
  // the port in `.env`, so they timed out against a gateway that was up on another port.
  it("comes from the shell first, as compose binds it", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_KONG_PORT=18473\n", "utf8")
    process.env["SUPATYPE_KONG_PORT"] = "18880"
    expect(readPersistedKongPort(dir)).toBe(18880)
  })

  it("comes from .env when the shell has none", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_KONG_PORT=18473\n", "utf8")
    expect(readPersistedKongPort(dir)).toBe(18473)
  })
})

describe("upsertEnvFile", () => {
  it("leaves .env untouched when nothing in it changes", () => {
    const path = join(dir, ".env")
    const past = new Date(Date.now() - 60_000)
    utimesSync(path, past, past)
    upsertEnvFile(dir, { SUPATYPE_DEV_DB_PORT: "54561", POSTGRES_DB: "demo" })
    expect(statSync(path).mtimeMs).toBeLessThan(Date.now() - 30_000)
    expect(readFileSync(path, "utf8")).toBe(ENV)
  })
})
