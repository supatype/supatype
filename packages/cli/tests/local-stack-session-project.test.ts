import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DockerAnswer } from "../src/docker-exec.js"
import { projectConfig } from "./support/project-config.js"
import { exitThrows } from "./support/process-exit.js"

/**
 * 0.9.2 round 2 (N2): `supatype dev` run with SUPATYPE_PROJECT_NAME in its shell names its stack
 * after that name, and a command run later from a shell without it looked for the stack under the
 * config's name: `admin create-user` said "The local stack isn't running" while dev ran. The live
 * session of this folder records the stack's compose project, and every command finds it there.
 */
const SESSION_PROJECT = "supatype-run-b"
const docker = vi.hoisted(() => ({ calls: [] as string[][], running: "" }))

/** Docker as these lookups ask it: only the stack named `docker.running` has containers. */
function fakeDocker(args: readonly string[]): DockerAnswer {
  docker.calls.push([...args])
  const named = args.includes(docker.running) || args.some((a) => a.endsWith(`=${docker.running}`))
  if (args[0] === "compose") return answer(0, named ? "abc123\n" : "")
  if (args[0] === "ps" && args.some((a) => a.startsWith("publish="))) return answer(0, `${docker.running}\n`)
  return answer(1, "")
}

/** A docker call that finished with `status` and printed `stdout`. */
function answer(status: number, stdout: string): DockerAnswer {
  return { status, stdout, stderr: "", timedOut: false, missing: false }
}
vi.mock("../src/docker-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-exec.js")>()),
  askDockerSync: (args: readonly string[]) => fakeDocker(args),
}))

const { enterLocalStack, devSessionLockFor, devSessionLockPath, localStackComposeProject, writeDevSessionLock } = await import(
  "../src/dev-session-lock.js"
)
const { requireStackDatabase } = await import("../src/local-stack-guard.js")
const { composeContext } = await import("../src/compose-services.js")
const { projectStackUrl } = await import("../src/local-stack.js")
const { selfHostComposePaths } = await import("../src/self-host-compose.js")

const acme = projectConfig({ project: { name: "acme" }, provider: "docker", database: { provider: "docker" } })
let dir = ""

/** The lock a running `supatype dev` writes, for the compose file of `owner`. */
function devSession(owner: string = dir): void {
  const stack = { composeProject: SESSION_PROJECT, composePath: selfHostComposePaths(owner).composePath, kongPort: 18740 }
  writeDevSessionLock(dir, devSessionLockFor(acme, stack))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-session-project-"))
  writeFileSync(join(dir, "supatype.config.mjs"), `export default ${JSON.stringify(acme)}\n`)
  mkdirSync(join(dir, ".supatype", "self-host"), { recursive: true })
  writeFileSync(selfHostComposePaths(dir).composePath, "services: {}\n")
  docker.calls.length = 0
  docker.running = SESSION_PROJECT
  vi.stubEnv("SUPATYPE_PROJECT_NAME", "")
  vi.stubEnv("SUPATYPE_KONG_PORT", "")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("the compose project of this folder's local stack", () => {
  it("is the one a running dev session of this folder started", () => {
    devSession()
    expect(localStackComposeProject(dir, acme.project.name)).toBe(SESSION_PROJECT)
  })

  it("is the config's with no session, a stopped one, or another folder's", () => {
    expect(localStackComposeProject(dir, "acme")).toBe("supatype-acme")
    // A lock naming no process is one a killed dev left behind.
    writeFileSync(devSessionLockPath(dir), JSON.stringify({ version: 1, composeProject: SESSION_PROJECT, projectRef: "acme", composePath: selfHostComposePaths(dir).composePath, kongPort: 18740, startedAt: "x" }))
    expect(localStackComposeProject(dir, "acme")).toBe("supatype-acme")
    devSession(join(dir, "elsewhere"))
    expect(localStackComposeProject(dir, "acme")).toBe("supatype-acme")
  })

  it("is the run's own when SUPATYPE_PROJECT_NAME is set in the command's shell", () => {
    devSession()
    vi.stubEnv("SUPATYPE_PROJECT_NAME", "other")
    expect(localStackComposeProject(dir, "other")).toBe("supatype-other")
  })
})

// 0.9.2 release test FF-7: compose run from a shell without dev's ports moved its stack onto the defaults.
// The session's lock here is one an older dev wrote, with no run environment: its two ports stand in.
describe("the ports of this folder's local stack", () => {
  it("are not put into the run's environment by finding its stack", () => {
    devSession()
    const before = { ...process.env }
    localStackComposeProject(dir, acme.project.name)
    expect(process.env).toEqual(before)
  })

  it("are the session's, put into the run's environment when it enters the stack", () => {
    devSession()
    const env: NodeJS.ProcessEnv = {}
    enterLocalStack(dir, acme.project.name, env)
    expect(env["SUPATYPE_KONG_PORT"]).toBe("18740")
  })

  // Round 4: the shell's port won, and compose moved the running Kong onto it.
  it("refuse a port the shell sets to another than the stack runs on", () => {
    devSession()
    const env: NodeJS.ProcessEnv = { SUPATYPE_KONG_PORT: "18741" }
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    exitThrows()
    expect(() => enterLocalStack(dir, acme.project.name, env)).toThrow("exit 1")
    expect(env["SUPATYPE_KONG_PORT"]).toBe("18741")
  })

  // Round 5 (S-3): the check trimmed, compose did not, so a padded copy of the stack's own port got
  // past it and every command then failed against `invalid hostPort:  18740`.
  it("refuse the stack's own port padded with spaces, quoting it, and say what it would do to any command", () => {
    devSession()
    const env: NodeJS.ProcessEnv = { SUPATYPE_KONG_PORT: " 18740" }
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    exitThrows()
    expect(() => enterLocalStack(dir, acme.project.name, env)).toThrow("exit 1")
    const said = [...error.mock.calls, ...log.mock.calls].flat().join("\n")
    expect(said).toContain('SUPATYPE_KONG_PORT=" 18740" is set in this shell')
    // Round 5 (S-5): `status` and `logs` were told they would move the stack.
    expect(said).toContain("any other would look for it on the wrong port")
  })

  it("take a shell setting the stack's own port", () => {
    devSession()
    const env: NodeJS.ProcessEnv = { SUPATYPE_KONG_PORT: "18740" }
    enterLocalStack(dir, acme.project.name, env)
    expect(env["SUPATYPE_KONG_PORT"]).toBe("18740")
  })

  it("are the session's when SUPATYPE_PROJECT_NAME names the session's own stack", () => {
    devSession()
    vi.stubEnv("SUPATYPE_PROJECT_NAME", "run-b")
    const env: NodeJS.ProcessEnv = {}
    enterLocalStack(dir, "run-b", env)
    expect(localStackComposeProject(dir, "run-b")).toBe(SESSION_PROJECT)
    expect(env["SUPATYPE_KONG_PORT"]).toBe("18740")
  })

  it("are left alone for another stack's name", () => {
    devSession()
    vi.stubEnv("SUPATYPE_PROJECT_NAME", "other")
    const env: NodeJS.ProcessEnv = {}
    enterLocalStack(dir, "other", env)
    expect(env).toEqual({})
  })

  it("are left alone with no live session", () => {
    const env: NodeJS.ProcessEnv = {}
    enterLocalStack(dir, acme.project.name, env)
    expect(env).toEqual({})
  })
})

describe("commands that find the stack by its compose project", () => {
  it("find the database of a dev stack started under another name (admin, seed, db commands)", () => {
    devSession()
    expect(() => requireStackDatabase(dir, acme, "admin create-user")).not.toThrow()
    expect(docker.calls.find((call) => call[0] === "compose")).toContain(SESSION_PROJECT)
  })

  it("still refuse when no dev session runs and the config's stack is not up", () => {
    expect(() => requireStackDatabase(dir, acme, "admin create-user")).toThrow(/isn't running/)
  })

  it("report on the session's stack (status, logs)", () => {
    devSession()
    expect(composeContext(dir)?.projectName).toBe(SESSION_PROJECT)
  })

  it("reach the session's gateway as the project's own, once the stack is entered", () => {
    devSession()
    enterLocalStack(dir, acme.project.name)
    expect(projectStackUrl(dir, acme, undefined)).toBe("http://localhost:18740")
  })
})
