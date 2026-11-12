/**
 * FF26 remainder (0.9.2 release test, pm): two `init -y` runs before either project starts both got
 * Kong port 18475. Init skipped ports Docker knew of, and a project nobody has started has no
 * containers yet. Init now records the port it gives a project under
 * `~/.supatype/init-ports.json`, one record per project folder, and the
 * next init skips it while that project's directory exists and its `.env` still names that port.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, recordScaffoldedKongPort, scaffold } from "../src/commands/init.js"
import { chooseInitKongPort, type ComposePortReader } from "../src/dev-ports.js"

/** Docker with no Supatype containers at all: the case of projects nobody has started. */
const NO_CONTAINERS: ComposePortReader = { listContainers: async () => "", portBindings: async () => "" }

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "b-init-kong-"))
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere.
  vi.stubEnv("HOME", join(root, "home"))
  vi.stubEnv("USERPROFILE", join(root, "home"))
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

/** `init -y` for project `name`: the port init picks, the files it writes with it, and the record. */
async function initProject(name: string, parent = root): Promise<{ dir: string; port: number }> {
  const port = await chooseInitKongPort(NO_CONTAINERS, {})
  mkdirSync(parent, { recursive: true })
  const dir = join(parent, name)
  const opts = { ...defaultScaffoldOptions(name), kongPort: port }
  // What createProject does: write the project, then record its port.
  scaffold(dir, opts)
  recordScaffoldedKongPort(dir, opts)
  return { dir, port }
}

describe("two init runs before either project starts", () => {
  it("give the second project a different Kong port", async () => {
    const b = await initProject("b-init-ff26-b")
    const c = await initProject("b-init-ff26-c")
    expect(c.port).not.toBe(b.port)
  })

  // Round 2 (pm N1): the record was one per project name, so the second folder's init replaced the
  // first's, and a third init was offered the first project's port again.
  it("give each of two folders with the same name its own Kong port, and keep both", async () => {
    const first = await initProject("b-init-ff26-same", join(root, "one"))
    const second = await initProject("b-init-ff26-same", join(root, "two"))
    const third = await chooseInitKongPort(NO_CONTAINERS, {})
    expect(new Set([first.port, second.port, third]).size).toBe(3)
  })

  it("free the first project's port once its directory is gone", async () => {
    const b = await initProject("b-init-ff26-b")
    rmSync(b.dir, { recursive: true, force: true })
    expect(await chooseInitKongPort(NO_CONTAINERS, {})).toBe(b.port)
  })

  it("free the port once the first project's .env names another", async () => {
    const b = await initProject("b-init-ff26-b")
    writeFileSync(join(b.dir, ".env"), "SUPATYPE_KONG_PORT=19999\n", "utf8")
    expect(await chooseInitKongPort(NO_CONTAINERS, {})).toBe(b.port)
  })
})
