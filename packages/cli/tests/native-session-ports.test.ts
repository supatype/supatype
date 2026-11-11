import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { projectConfig } from "./support/project-config.js"
import { exitThrows } from "./support/process-exit.js"

/**
 * 0.9.2 release test round 5, FF-7 on native: native dev wrote no session record, so `push` from a
 * shell with another SUPATYPE_DEV_DB_PORT took that shell's port. On WSL it waited 37 to 47 s to
 * fail; on Windows, with another Postgres on that port, it began applying the migration there.
 * Native dev now records its port, and host commands take it or refuse another, as with Docker.
 */
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  // No Docker on this machine as far as these commands can tell: native dev has no stack.
  spawnSync: () => ({ status: 1, stdout: "", stderr: "" }),
}))

const { devSessionLockFor, enterLocalStack, writeDevSessionLock } = await import("../src/dev-session-lock.js")
const { composeRenderMode } = await import("../src/compose-render-mode.js")
const { resolveHostDatabaseUrl } = await import("../src/host-database.js")
const { composeProjectName, selfHostComposePaths } = await import("../src/self-host-compose.js")

const native = projectConfig({ project: { name: "notes" }, provider: "native", database: { provider: "native" } })
let dir = ""

/** The record native dev writes once it is up on `port`; the test runner's pid stands in for dev's. */
function nativeSession(port: number): void {
  writeDevSessionLock(dir, devSessionLockFor(native, {
    provider: "native",
    composeProject: composeProjectName("notes"),
    composePath: selfHostComposePaths(dir).composePath,
    dbPort: port,
    runEnv: { SUPATYPE_DEV_DB_PORT: String(port) },
  }))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-native-session-"))
  vi.stubEnv("SUPATYPE_PROJECT_NAME", "")
  vi.stubEnv("SUPATYPE_DEV_DB_PORT", "")
  vi.stubEnv("DATABASE_URL", "")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("a host command while native dev runs", () => {
  it("refuses a shell naming another database port, and touches nothing", () => {
    nativeSession(55292)
    const env: NodeJS.ProcessEnv = { SUPATYPE_DEV_DB_PORT: "55293" }
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    exitThrows()
    expect(() => enterLocalStack(dir, "notes", env)).toThrow("exit 1")
    expect([...error.mock.calls, ...log.mock.calls].flat().join("\n")).toContain("SUPATYPE_DEV_DB_PORT=55293 is set in this shell, and the stack runs on 55292.")
    expect(env).toEqual({ SUPATYPE_DEV_DB_PORT: "55293" })
  })

  it("takes the session's port from a clean shell", () => {
    nativeSession(55292)
    const env: NodeJS.ProcessEnv = {}
    enterLocalStack(dir, "notes", env)
    expect(env["SUPATYPE_DEV_DB_PORT"]).toBe("55292")
  })

  it("reaches the session's database when push derives its URL", () => {
    nativeSession(55292)
    expect(resolveHostDatabaseUrl(dir, native, { allowDerived: true }).dsn).toContain(":55292/")
  })

  it("does not make a compose render dev: native dev has no compose stack", () => {
    nativeSession(55292)
    expect(composeRenderMode(dir, "notes")).toBe("standalone")
  })
})
