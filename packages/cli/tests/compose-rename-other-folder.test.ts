import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DockerAnswer } from "../src/docker-exec.js"

/**
 * 0.9.2 release test round 5 (RB-2): after a rename, dev offered to stop the stack of the old name,
 * and that stack could be another folder's of the same project: saying yes stopped it. A stack of
 * the old name another folder started is not offered.
 */
const docker = vi.hoisted(() => ({ files: "", composeRuns: 0 }))
vi.mock("../src/docker-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-exec.js")>()),
  askDockerSync: (args: readonly string[]): DockerAnswer => {
    const format = args[args.indexOf("--format") + 1] ?? ""
    const stdout = format.includes("config_files") ? docker.files : "supatype-old-db-1\n"
    return { status: 0, stdout, stderr: "", timedOut: false, missing: false }
  },
}))
vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  runDockerCompose: () => {
    docker.composeRuns += 1
    return 0
  },
}))
const asked = vi.hoisted(() => ({ count: 0 }))
vi.mock("../src/ui/confirm.js", () => ({
  confirm: async () => {
    asked.count += 1
    return true
  },
}))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => true }))

const { handleComposeProjectRename } = await import("../src/compose-rename.js")
const { selfHostComposePaths } = await import("../src/self-host-compose.js")
const { writeLocalEnvironment } = await import("../src/link.js")
const { forgetStackFolders } = await import("../src/stack-folder.js")

let here = ""
let there = ""
beforeEach(() => {
  here = mkdtempSync(join(tmpdir(), "supatype-rename-here-"))
  there = mkdtempSync(join(tmpdir(), "supatype-rename-there-"))
  writeLocalEnvironment(here, { target: "local", apiUrl: "http://localhost:18740", databaseUrl: "postgres://x", projectRef: "old", kongPort: 18740, provider: "docker" })
  docker.composeRuns = 0
  asked.count = 0
  forgetStackFolders()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(here, { recursive: true, force: true })
  rmSync(there, { recursive: true, force: true })
})

describe("the stack of a project's old name", () => {
  it("is not offered for stopping when another folder started it", async () => {
    docker.files = `${selfHostComposePaths(there).composePath}\n`
    await handleComposeProjectRename(here, "new", selfHostComposePaths(here))
    expect(asked.count).toBe(0)
    expect(docker.composeRuns).toBe(0)
  })

  it("is offered, and stopped, when this folder started it", async () => {
    docker.files = `${selfHostComposePaths(here).composePath}\n`
    await handleComposeProjectRename(here, "new", selfHostComposePaths(here))
    expect(asked.count).toBe(1)
    expect(docker.composeRuns).toBe(1)
  })
})
