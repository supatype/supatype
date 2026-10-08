import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import type { SpawnSyncReturns } from "node:child_process"

/**
 * The files `engineRequest` hands the engine live in a directory every CLI process shares, and a
 * request can carry `database_url` with its password. So they are private to this user, and none
 * outlives the request: not when the engine fails, and not when building the request fails part way,
 * which used to leave every file written before the failure behind.
 */

// `vi.mock` is hoisted above the imports, so the directory is handed to it through this.
const temp = vi.hoisted(() => ({ root: "" }))
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  tmpdir: () => temp.root,
}))

const { tmpdir: realTmpdir } = await vi.importActual<typeof import("node:os")>("node:os")
const root = mkdtempSync(join(realTmpdir(), "supatype-engine-files-"))
temp.root = root
const engineDir = join(root, "supatype-engine")
vi.mock("../src/config.js", () => ({ loadConfig: () => ({}) }))
vi.mock("../src/ensure-binary.js", () => ({ ensureBinary: async () => "/fake/supatype-engine" }))

/** What each file named on the engine's command line looked like when the engine ran. */
let seen: Array<{ path: string; mode: number }> = []
const spawnSync = vi.fn<(cmd: string, args: readonly string[]) => Partial<SpawnSyncReturns<string>>>()
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (cmd: string, args: readonly string[]) => {
    seen = args
      .filter((a) => a.startsWith(engineDir))
      .map((path) => ({ path, mode: statSync(path).mode & 0o777 }))
    return spawnSync(cmd, args)
  },
}))

const { engineRequest } = await import("../src/engine-client.js")

const posix = process.platform !== "win32"

beforeEach(() => {
  seen = []
  spawnSync.mockReset()
  spawnSync.mockReturnValue({ status: 0, stdout: "{}", stderr: "" })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const leftovers = () => (existsSync(engineDir) ? readdirSync(engineDir) : [])

describe("engine request files", () => {
  it.skipIf(!posix)("are readable by this user only, in a directory only this user can list", async () => {
    await engineRequest("/seed", {
      ast: { models: [] },
      database_url: "postgresql://supatype_admin:secret@127.0.0.1:54329/app",
      ir_documents: [{ writes: [] }],
      schema_sources_gz_base64: Buffer.from("gz").toString("base64"),
    })

    expect(seen.length).toBeGreaterThanOrEqual(2)
    for (const file of seen) expect(file.mode).toBe(0o600)
    expect(statSync(engineDir).mode & 0o777).toBe(0o700)
  })

  it.skipIf(!posix)("narrows a directory an older CLI left open", async () => {
    rmSync(engineDir, { recursive: true, force: true })
    mkdirSync(engineDir, { mode: 0o755 })
    await engineRequest("/validate", { ast: {} })
    expect(statSync(engineDir).mode & 0o777).toBe(0o700)
  })

  it("are removed once the engine has run, and when it fails", async () => {
    await engineRequest("/validate", { ast: {} })
    expect(leftovers()).toEqual([])

    spawnSync.mockReturnValue({ status: 2, stdout: "", stderr: "boom" })
    await expect(engineRequest("/validate", { ast: {} })).rejects.toThrow(/boom/)
    expect(leftovers()).toEqual([])
  })

  // The request file was written, then the seed document could not be serialised. The throw skipped
  // the cleanup loop, and the request file stayed in the shared directory.
  it("are removed when a later file cannot be written", async () => {
    await expect(
      engineRequest("/seed", { ast: { models: [] }, ir_documents: [{ big: 1n }] }),
    ).rejects.toThrow(/BigInt/)

    expect(spawnSync).not.toHaveBeenCalled()
    expect(leftovers()).toEqual([])
  })
})
