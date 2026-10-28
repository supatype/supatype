import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Local test G: native dev checked Postgres, the server, PostgREST and realtime for a port already
 * in use, and never the port the server starts Deno on (8001, or `SUPATYPE_DENO_PORT`). With
 * something there, Deno failed to bind after the stack was up and every function answered 502.
 */

const busy = vi.hoisted(() => new Set<number>())

vi.mock("../src/postgres-ctl.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/postgres-ctl.js")>()),
  isPortInUse: vi.fn(async (port: number) => busy.has(port)),
}))

vi.mock("../src/ui/fatal.js", () => ({
  fatalError: (message: string, hints: string[] = []): never => {
    throw new Error([message, ...hints].join("\n"))
  },
}))

const { assertNativeDevPortsFree } = await import("../src/commands/dev.js")
const { nativeDenoPort } = await import("../src/project-config.js")

const PORTS = { postgres: 54339, server: 54321, postgrest: 3001, realtime: 4000 }
let cwd: string

beforeEach(() => {
  busy.clear()
  vi.stubEnv("SUPATYPE_DENO_PORT", undefined)
  cwd = mkdtempSync(join(tmpdir(), "supatype-deno-port-"))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(cwd, { recursive: true, force: true })
})

describe("native dev's Deno port", () => {
  it("refuses to start when the Deno port is taken, naming the variable that moves it", async () => {
    busy.add(8001)
    await expect(assertNativeDevPortsFree({ ...PORTS, deno: 8001 })).rejects.toThrow(
      /Port 8001 is already in use[\s\S]*SUPATYPE_DENO_PORT/,
    )
  })

  it("starts when the Deno port is free", async () => {
    busy.add(8002)
    await expect(assertNativeDevPortsFree({ ...PORTS, deno: 8001 })).resolves.toBeUndefined()
  })

  it("is 8001 unless SUPATYPE_DENO_PORT moves it, from the shell first, then .env", () => {
    expect(nativeDenoPort(cwd)).toBe(8001)
    writeFileSync(join(cwd, ".env"), "SUPATYPE_DENO_PORT=18495\n", "utf8")
    expect(nativeDenoPort(cwd)).toBe(18495)
    vi.stubEnv("SUPATYPE_DENO_PORT", "18494")
    expect(nativeDenoPort(cwd)).toBe(18494)
  })
})
