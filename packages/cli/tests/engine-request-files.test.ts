import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs"
import { dirname, join, sep } from "node:path"
import type { SpawnSyncReturns } from "node:child_process"

/**
 * The files `engineRequest` hands the engine live under the shared system temp directory, and a
 * request can carry `database_url` with its password. So each request gets a directory of its own,
 * created fresh and private to this user, and nothing outlives the request: not when the engine
 * fails, and not when building the request fails part way.
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
vi.mock("../src/config.js", () => ({ loadConfig: () => ({}) }))
vi.mock("../src/ensure-binary.js", () => ({ ensureBinary: async () => "/fake/supatype-engine" }))

/** What each file named on the engine's command line looked like when the engine ran. */
interface SeenFile {
  path: string
  mode: number
  dirMode: number
  dirIsLink: boolean
  content: string
}
let seen: SeenFile[] = []
const spawnSync = vi.fn<(cmd: string, args: readonly string[]) => Partial<SpawnSyncReturns<string>>>()
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (cmd: string, args: readonly string[]) => {
    seen = args
      .filter((a) => a.startsWith(root))
      .map((path) => ({
        path,
        mode: statSync(path).mode & 0o777,
        dirMode: statSync(dirname(path)).mode & 0o777,
        dirIsLink: lstatSync(dirname(path)).isSymbolicLink(),
        content: readFileSync(path, "utf8"),
      }))
    return spawnSync(cmd, args)
  },
}))

const { engineRequest } = await import("../src/engine-client.js")

const posix = process.platform !== "win32"
const uid = process.getuid?.()
/** The fixed per-user directory earlier CLIs used, which anyone could create first. */
const oldDir = join(root, uid === undefined ? "supatype-engine" : `supatype-engine-${uid}`)

beforeEach(() => {
  seen = []
  spawnSync.mockReset()
  spawnSync.mockReturnValue({ status: 0, stdout: "{}", stderr: "" })
  for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Everything left under the temp root by the requests, apart from what a test planted. */
const leftovers = (planted: string[] = []) =>
  readdirSync(root).filter((name) => !planted.includes(join(root, name)))

const seedBody = {
  ast: { models: [] },
  database_url: "postgresql://supatype_admin:secret@127.0.0.1:54329/app",
  ir_documents: [{ writes: [] }],
  schema_sources_gz_base64: Buffer.from("gz").toString("base64"),
}

describe("engine request files", () => {
  it.skipIf(!posix)("are readable by this user only, in a directory only this user can list", async () => {
    await engineRequest("/seed", seedBody)

    expect(seen.length).toBeGreaterThanOrEqual(2)
    for (const file of seen) {
      expect(file.mode).toBe(0o600)
      expect(file.dirMode).toBe(0o700)
    }
  })

  // A request without an AST is written whole; the connection string goes to the engine separately.
  it("never hold the database URL", async () => {
    await engineRequest("/status", { database_url: seedBody.database_url, action: "list" })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.content).toContain("list")
    expect(seen[0]!.content).not.toContain("secret")
  })

  it("go in a new directory for each request", async () => {
    await engineRequest("/validate", { ast: {} })
    const first = dirname(seen[0]!.path)
    await engineRequest("/validate", { ast: {} })
    const second = dirname(seen[0]!.path)

    expect(first).not.toBe(second)
    expect(dirname(first)).toBe(root)
  })

  // Another user creates the old fixed path first, world-writable, and watches it. The request
  // must not write there: it would hand them the request file and its `database_url`.
  it("never use a directory someone else created at the old fixed path", async () => {
    mkdirSync(oldDir, { mode: 0o777 })

    await engineRequest("/seed", seedBody)

    expect(seen.length).toBeGreaterThanOrEqual(2)
    for (const file of seen) expect(file.path.startsWith(oldDir + sep)).toBe(false)
    expect(readdirSync(oldDir)).toEqual([])
    expect(leftovers([oldDir])).toEqual([])
  })

  it.skipIf(!posix)("never write through a link planted at the old fixed path", async () => {
    const target = mkdtempSync(join(root, "attacker-"))
    symlinkSync(target, oldDir)

    await engineRequest("/seed", seedBody)

    for (const file of seen) {
      expect(file.path.startsWith(oldDir + sep)).toBe(false)
      expect(file.dirIsLink).toBe(false)
    }
    expect(readdirSync(target)).toEqual([])
    expect(leftovers([oldDir, target])).toEqual([])
  })

  it("are removed, with their directory, once the engine has run, and when it fails", async () => {
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
    expect(existsSync(oldDir)).toBe(false)
  })
})
