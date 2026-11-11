import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DockerAnswer } from "../src/docker-exec.js"
import { exitThrows } from "./support/process-exit.js"

/**
 * 0.9.2 release test round 5 (RB-2): a second folder of the same project names the same stack, and
 * its `self-host compose down` removed the first folder's running dev stack with exit 0. Compose
 * records on each container the files it was started from; a stack whose files are another
 * folder's is refused, and its mode is not taken for this folder's renders.
 */
const docker = vi.hoisted(() => ({ files: [] as string[], volumes: false }))

/** Docker as the guard and the render mode ask it, for one stack started from `docker.files`. */
function fakeDocker(args: readonly string[]): DockerAnswer {
  if (args[0] === "volume") return answer(docker.volumes ? "supatype-acme_db-data\n" : "")
  const format = args[args.indexOf("--format") + 1] ?? ""
  if (args[0] === "ps" && format.includes("config_files")) return answer(docker.files.map((f) => `${f}\n`).join(""))
  if (args[0] === "ps" && args.includes("-q")) return answer(docker.files.length > 0 ? "abc123\n" : "")
  if (args[0] === "inspect") return answer("SUPATYPE_MODE=dev\n")
  return { ...answer(""), status: 1 }
}

function answer(stdout: string): DockerAnswer {
  return { status: 0, stdout, stderr: "", timedOut: false, missing: false }
}
vi.mock("../src/docker-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-exec.js")>()),
  askDockerSync: (args: readonly string[]) => fakeDocker(args),
}))

const { forgetStackFolders, otherFoldersStack, recordStackFolder } = await import("../src/stack-folder.js")
const { enterLocalStack } = await import("../src/dev-session-lock.js")
const { runningStackMode } = await import("../src/compose-render-mode.js")
const { selfHostComposePaths } = await import("../src/self-host-compose.js")

let here = ""
let there = ""
beforeEach(() => {
  here = mkdtempSync(join(tmpdir(), "supatype-stack-here-"))
  there = mkdtempSync(join(tmpdir(), "supatype-stack-there-"))
  docker.files = []
  docker.volumes = false
  forgetStackFolders()
  vi.stubEnv("SUPATYPE_PROJECT_NAME", "")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(here, { recursive: true, force: true })
  rmSync(there, { recursive: true, force: true })
})

const composeFile = (folder: string): string => selfHostComposePaths(folder).composePath

// With the first folder's containers gone its database volume is left, and nothing on Docker names
// that folder: the record its start left in ~/.supatype/stacks.json (the test run's own home) does.
describe("the folder of a stack with no containers", () => {
  it("is the folder that last started it, while its volumes are left", () => {
    recordStackFolder(there, "supatype-acme")
    docker.volumes = true
    expect(otherFoldersStack(here, "supatype-acme", [])).toBe(there)
  })

  it("is none to object to once its volumes are gone", () => {
    recordStackFolder(there, "supatype-acme")
    expect(otherFoldersStack(here, "supatype-acme", [])).toBeUndefined()
  })

  it("is none to object to once the recording folder is deleted", () => {
    recordStackFolder(there, "supatype-acme")
    rmSync(there, { recursive: true, force: true })
    docker.volumes = true
    expect(otherFoldersStack(here, "supatype-acme", [])).toBeUndefined()
  })

  it("is this folder's once this folder starts it", () => {
    recordStackFolder(there, "supatype-acme")
    recordStackFolder(here, "supatype-acme")
    docker.volumes = true
    expect(otherFoldersStack(here, "supatype-acme", [])).toBeUndefined()
  })
})

describe("the folder a stack belongs to", () => {
  it("is this one when every container was started from this folder's compose file", () => {
    expect(otherFoldersStack(here, "supatype-acme", [[composeFile(here)], [composeFile(here)]])).toBeUndefined()
  })

  it("is none to object to when the stack has no containers, or docker cannot say", () => {
    expect(otherFoldersStack(here, "supatype-acme", [])).toBeUndefined()
    expect(otherFoldersStack(here, "supatype-acme", null)).toBeUndefined()
  })

  it("is the other folder's when a container was started from its file", () => {
    expect(otherFoldersStack(here, "supatype-acme", [[composeFile(here)], [composeFile(there)]])).toBe(there)
  })

  it("is this one when this folder's file is among several a container was started from", () => {
    expect(otherFoldersStack(here, "supatype-acme", [[composeFile(here), join(here, "override.yml")]])).toBeUndefined()
  })
})

describe("entering the local stack", () => {
  it("refuses a stack another folder started, naming that folder", () => {
    docker.files = [composeFile(there)]
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    exitThrows()
    expect(() => enterLocalStack(here, "acme", {})).toThrow("exit 1")
    expect(error.mock.calls.flat().join("\n")).toContain(there)
  })

  it("takes this folder's own stack", () => {
    docker.files = [composeFile(here)]
    expect(enterLocalStack(here, "acme", {})).toBe("supatype-acme")
  })
})

describe("the render mode", () => {
  it("is not taken from a server another folder started", () => {
    docker.files = [composeFile(there)]
    expect(runningStackMode(here, "acme")).toBeUndefined()
  })

  it("is taken from this folder's own server", () => {
    docker.files = [composeFile(here)]
    expect(runningStackMode(here, "acme")).toBe("dev")
  })
})
