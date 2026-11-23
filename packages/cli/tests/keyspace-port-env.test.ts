import { createServer } from "node:net"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KEYSPACE_PORT_ENV, keyspacePorts } from "../src/keyspace-port.js"
import { machineKeyspaceChecks, nativeKeyspacePort } from "../src/native-keyspace.js"
import { ensureValkeySidecar, type DockerResult } from "../src/valkey-sidecar.js"
import { projectConfig } from "./support/project-config.js"
import { freePort } from "./support/ports.js"

/**
 * FF-33: native dev took the first free port from 6379 and nothing could move it, so a second
 * project, or a developer's own Redis, left the keyspace on a port nobody chose. `SUPATYPE_KEYSPACE_PORT`
 * names the port for a run, in the shell or in `.env` as the other native port variables are, and
 * both the Postgres keyspace and the Valkey sidecar that stands in for it follow it.
 */
const dirs: string[] = []
function project(env = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-keyspace-port-"))
  dirs.push(dir)
  if (env !== "") writeFileSync(join(dir, ".env"), env, "utf8")
  return dir
}

beforeEach(() => {
  vi.stubEnv(KEYSPACE_PORT_ENV, "")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("keyspacePorts", () => {
  it("looks from 6379 across ten ports when the variable is not set", () => {
    expect(keyspacePorts(project())).toEqual({ base: 6379, span: 10, named: false })
  })

  it("is exactly the port the shell names", () => {
    vi.stubEnv(KEYSPACE_PORT_ENV, "6400")
    expect(keyspacePorts(project())).toEqual({ base: 6400, span: 1, named: true })
  })

  it("reads .env, and the shell wins over it", () => {
    const dir = project(`${KEYSPACE_PORT_ENV}=6401\n`)
    expect(keyspacePorts(dir)).toEqual({ base: 6401, span: 1, named: true })
    vi.stubEnv(KEYSPACE_PORT_ENV, "6402")
    expect(keyspacePorts(dir).base).toBe(6402)
  })

  it.each([["abc"], ["0"], ["65536"], ["63.79"], ["-1"]])("refuses %s, naming the variable", (value) => {
    vi.stubEnv(KEYSPACE_PORT_ENV, value)
    expect(() => keyspacePorts(project())).toThrow(new RegExp(`${KEYSPACE_PORT_ENV}.*${value.replace(".", "\.")}`))
  })
})

describe("native dev's keyspace port", () => {
  const config = projectConfig({ project: { name: "acme" }, database: { provider: "native" }, versions: { postgres: "17.2" } })
  const archive = (): string => {
    const root = project()
    const bin = join(root, "bin")
    return bin
  }

  it("is the port the variable names", async () => {
    const port = await freePort()
    vi.stubEnv(KEYSPACE_PORT_ENV, String(port))
    const dir = project()
    const checks = { ...machineKeyspaceChecks(dir), libraryPresent: () => true }
    await expect(nativeKeyspacePort(config, archive(), "17.2.15", checks)).resolves.toBe(port)
  })

  it("starts without the keyspace, naming the variable, when the port it names is taken", async () => {
    const held = createServer()
    await new Promise<void>((done) => held.listen(0, "127.0.0.1", done))
    const address = held.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    vi.stubEnv(KEYSPACE_PORT_ENV, String(port))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const checks = { ...machineKeyspaceChecks(project()), libraryPresent: () => true }
      await expect(nativeKeyspacePort(config, archive(), "17.2.15", checks)).resolves.toBeNull()
      expect(warn.mock.calls.flat().join("\n")).toContain(`${KEYSPACE_PORT_ENV}=${port}`)
    } finally {
      await new Promise((done) => held.close(done))
    }
  })
})

describe("the Valkey sidecar's port", () => {
  it("is the port the variable names", async () => {
    const port = await freePort()
    vi.stubEnv(KEYSPACE_PORT_ENV, String(port))
    vi.stubEnv("SUPATYPE_VALKEY_ADDR", "")
    const ran: string[][] = []
    const ok: DockerResult = { status: 0, stdout: "", stderr: "", error: undefined, timedOut: false } as DockerResult
    await ensureValkeySidecar("acme", project(), {
      docker: async (args) => {
        ran.push([...args])
        return ok
      },
    }).catch(() => undefined)
    const run = ran.find((args) => args[0] === "run")
    expect(run?.join(" ")).toContain(`127.0.0.1:${port}:6379`)
  })
})
