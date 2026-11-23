import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * A slow or broken Docker is not a stack that is down. `supatype seed` and `migrate` told a
 * developer "The local stack isn't running" when `docker ps` merely timed out, because every
 * unanswered question was read as "no container". The check now waits through a slow answer, and
 * says Docker did not respond when it never does.
 */

type Reply = "timeout" | "fail" | "none" | "running"

/** What the fake docker answers to the server-container lookup, one reply per call, the last one repeated. */
const docker = vi.hoisted(() => ({ replies: [] as string[], serverCalls: 0, calls: [] as string[][] }))

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const timedOut = { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" }) }
  const fake = (command: string, args: readonly string[] = []) => {
    if (command !== "docker") return { status: 0, stdout: "", stderr: "" }
    docker.calls.push([...args])
    const isServerLookup = args[0] === "ps" && args.includes("label=com.docker.compose.service=server")
    const isServiceLookup = args.includes("compose") && args.includes("ps")
    if (args[0] === "ps" && !isServerLookup) return { status: 0, stdout: "", stderr: "" }
    if (args[0] === "inspect") return { status: 0, stdout: "SUPATYPE_MODE=dev\n", stderr: "" }
    if (isServerLookup || isServiceLookup) {
      const reply = docker.replies[Math.min(docker.serverCalls++, docker.replies.length - 1)]
      if (reply === "timeout") return timedOut
      if (reply === "fail") return { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }
      if (reply === "running") return { status: 0, stdout: "c0ffee\n", stderr: "" }
      return { status: 0, stdout: "", stderr: "" }
    }
    return { status: 0, stdout: "", stderr: "" }
  }
  return { ...actual, spawnSync: fake }
})

const { runningStackMode } = await import("../src/compose-render-mode.js")
const { composeServiceIsRunning } = await import("../src/compose-kong.js")
const { DockerNotResponding } = await import("../src/docker-exec.js")
const { NoStackRunning } = await import("../src/host-database.js")

let home: string
let project: string
const savedHome = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] }

function script(...replies: Reply[]): void {
  docker.replies = replies
  docker.serverCalls = 0
  docker.calls = []
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "supatype-docker-check-home-"))
  project = mkdtempSync(join(tmpdir(), "supatype-docker-check-project-"))
  process.env["HOME"] = home
  process.env["USERPROFILE"] = home
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedHome)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe("runningStackMode with a slow Docker", () => {
  it("waits through a Docker that times out first and then answers", () => {
    script("timeout", "running")
    expect(runningStackMode(project, "shop")).toBe("dev")
    expect(docker.serverCalls).toBe(2)
  })

  it("waits through a Docker that fails first and then answers", () => {
    script("fail", "running")
    expect(runningStackMode(project, "shop")).toBe("dev")
  })

  it("reports Docker did not respond, not a stack that is down, when it never answers", () => {
    script("timeout")
    const err = (() => {
      try {
        runningStackMode(project, "shop")
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect(err).toBeInstanceOf(DockerNotResponding)
    expect(err).not.toBeInstanceOf(NoStackRunning)
    expect((err as Error).message).toMatch(/Docker did not respond/)
    expect((err as Error).message).not.toMatch(/isn't running/)
  })

  it("still says no stack when Docker answers that nothing runs", () => {
    script("none")
    expect(runningStackMode(project, "shop")).toBeUndefined()
    expect(docker.serverCalls).toBe(1)
  })
})

describe("composeServiceIsRunning with a slow Docker", () => {
  const stack = { project: "supatype-shop", composePath: "compose.yml" }

  it("waits through a timeout and then answers", () => {
    script("timeout", "running")
    expect(composeServiceIsRunning(project, stack, "db")).toBe(true)
  })

  it("throws Docker did not respond when it never answers", () => {
    script("fail")
    expect(() => composeServiceIsRunning(project, stack, "db")).toThrow(DockerNotResponding)
  })

  it("is false when Docker answers that the service is not running", () => {
    script("none")
    expect(composeServiceIsRunning(project, stack, "db")).toBe(false)
  })
})
