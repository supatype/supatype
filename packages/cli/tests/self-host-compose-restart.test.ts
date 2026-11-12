import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"

const projectConfig: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "standalone" },
  app: { mode: "none" },
}

// `compose up` checks the stack's published ports first (issue 57): nothing holds them here.
vi.mock("../src/compose-services.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-services.js")>()),
  takenComposePorts: async () => [],
}))
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>()
  return { ...actual, loadConfig: () => projectConfig }
})

interface ComposeCall {
  composePath: string
  args: string[]
  projectRoot: string | undefined
  project: string | undefined
}

const calls: ComposeCall[] = []
const rendered: string[] = []
let composeStatus = 0

// Rendering is covered by self-host-compose-mounts.test.ts; this is about what the command runs.
vi.mock("../src/self-host-compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/self-host-compose.js")>()
  return {
    ...actual,
    writeSelfHostCompose: (cwd: string) => {
      rendered.push(cwd)
      return {
        dir: cwd,
        composePath: join(cwd, "docker-compose.yml"),
        kongPath: join(cwd, "kong.yml"),
        nginxPath: join(cwd, "nginx.conf"),
        s3ConfigPath: join(cwd, "s3.json"),
      }
    },
    runDockerCompose: (composePath: string, args: string[], projectRoot?: string, project?: string) => {
      calls.push({ composePath, args, projectRoot, project })
      return composeStatus
    },
  }
})

// What the stack does once compose returns: nothing failing unless a test says otherwise.
let failing: { service: string; exitCode?: number; restarting?: true } | undefined
vi.mock("../src/stack-exit-watch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/stack-exit-watch.js")>()),
  composeStackWatch: () => ({ logTail: async () => "storage: S3_REGION is not set" }),
  watchForFailure: async () => failing,
}))

import { registerSelfHost } from "../src/commands/self-host.js"
import { devSessionLockFor, writeDevSessionLock } from "../src/dev-session-lock.js"
import { selfHostComposePaths } from "../src/self-host-compose.js"
import { exitThrows } from "./support/process-exit.js"

/**
 * SA3: the way to pick up a changed `.env` for one service was to type a compose command by hand,
 * and a hand-typed one mounted the wrong folders. `supatype self-host compose restart <service>`
 * renders the file from the current config and recreates that one service, the same way the CLI's
 * own commands run compose, so nobody needs to.
 */
let projectDir = ""
let originalCwd = ""

async function run(...args: string[]): Promise<void> {
  const program = new Command().name("supatype").exitOverride()
  registerSelfHost(program)
  await program.parseAsync(["node", "supatype", "self-host", "compose", ...args])
}

beforeEach(() => {
  projectDir = join(tmpdir(), `supatype-selfhost-restart-${process.pid}-${Date.now()}`)
  mkdirSync(projectDir, { recursive: true })
  originalCwd = process.cwd()
  process.chdir(projectDir)
  calls.length = 0
  rendered.length = 0
  composeStatus = 0
  failing = undefined
  process.exitCode = undefined
})

afterEach(() => {
  process.chdir(originalCwd)
  process.exitCode = undefined
  vi.restoreAllMocks()
  rmSync(projectDir, { recursive: true, force: true })
})

describe("self-host compose status", () => {
  // N-FF11: `ps` lists running containers only, so an exited storage was missing from the list.
  it("lists every service, stopped ones included", async () => {
    await run("status")
    expect(calls[0]?.args).toEqual(["ps", "--all"])
  })

  // 0.9.2 round 2 (N2): dev run with SUPATYPE_PROJECT_NAME in its shell named its stack after it.
  it("is the stack a running dev session of this folder started under another name", async () => {
    const stack = { composeProject: "supatype-run-b", composePath: selfHostComposePaths(process.cwd()).composePath, kongPort: 18740 }
    writeDevSessionLock(process.cwd(), devSessionLockFor(projectConfig, stack))
    await run("status")
    expect(calls[0]?.project).toBe("supatype-run-b")
  })
})

describe("self-host compose restart <service> (SA3)", () => {
  it("renders the compose file, then recreates only the named service in this project's stack", async () => {
    await run("restart", "server")

    expect(rendered).toEqual([process.cwd()])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(["up", "-d", "--force-recreate", "--no-deps", "server"])
    expect(calls[0]?.projectRoot).toBe(process.cwd())
    expect(calls[0]?.project).toBe("supatype-acme")
  })

  it("needs a service name", async () => {
    await expect(run("restart")).rejects.toThrow(/missing required argument/i)
    expect(calls).toHaveLength(0)
  })

  // 0.9.2 release test round 2 (N-FF11): a storage container that refuses its settings exits as it
  // starts. Compose had started it, so the restart said nothing and exited 0.
  it("says so and exits 1 when the recreated service keeps exiting", async () => {
    failing = { service: "storage", exitCode: 1, restarting: true }
    const said: string[] = []
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { said.push(String(line)) })
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { said.push(String(line)) })

    await run("restart", "storage")

    expect(process.exitCode).toBe(1)
    expect(said.join("\n")).toMatch(/storage[\s\S]*S3_REGION is not set[\s\S]*compose logs --service storage/)
  })

  it("passes compose's failure on as the exit code", async () => {
    composeStatus = 3
    const exit = exitThrows()
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    await expect(run("restart", "server")).rejects.toThrow("exit 3")

    expect(exit).toHaveBeenCalledWith(3)
  })
})
