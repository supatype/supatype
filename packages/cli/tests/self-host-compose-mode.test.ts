import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * SH2: every `supatype self-host compose` command rendered the file as standalone, so restarting one
 * service of a stack `supatype dev` started recreated that service as production (and `up -d` did
 * the same to the database and the object store), in the middle of a dev session. These commands now
 * take the mode the same way a push does: dev while a dev session holds the lock, else the running
 * server's own mode, else standalone.
 */

const projectConfig: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "standalone" },
  app: { mode: "none" },
}

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig: () => projectConfig,
}))

const docker = vi.hoisted(() => ({ serverMode: undefined as "dev" | "standalone" | undefined }))
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const fake = (command: string, args: readonly string[] = []) => {
    const running = command === "docker" && docker.serverMode !== undefined
    if (args[0] === "ps") return { status: 0, stdout: running ? "c0ffee\n" : "", stderr: "" }
    if (args[0] === "inspect") return { status: running ? 0 : 1, stdout: `SUPATYPE_MODE=${docker.serverMode}\n`, stderr: "" }
    return { status: 0, stdout: "", stderr: "" }
  }
  return { ...actual, spawnSync: fake }
})

const rendered = vi.hoisted(() => ({ options: [] as Array<{ devLocal?: boolean } | undefined> }))
vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  writeSelfHostCompose: (cwd: string, _config: unknown, options?: { devLocal?: boolean }) => {
    rendered.options.push(options)
    return {
      dir: cwd,
      composePath: join(cwd, "docker-compose.yml"),
      kongPath: join(cwd, "kong.yml"),
      nginxPath: join(cwd, "nginx.conf"),
      s3ConfigPath: join(cwd, "s3.json"),
    }
  },
  runDockerCompose: () => 0,
}))

const { registerSelfHost } = await import("../src/commands/self-host.js")

let projectDir = ""
let originalCwd = ""

async function run(...args: string[]): Promise<void> {
  const program = new Command().name("supatype").exitOverride()
  registerSelfHost(program)
  await program.parseAsync(["node", "supatype", "self-host", "compose", ...args])
}

/** A live dev session lock, naming this project's own compose file as `supatype dev` writes it. */
function holdDevLock(): void {
  mkdirSync(join(projectDir, ".supatype"), { recursive: true })
  writeFileSync(
    join(projectDir, ".supatype", "dev-session.json"),
    JSON.stringify({ version: 1, composeProject: "supatype-acme", projectRef: "acme", composePath: join(projectDir, ".supatype", "self-host", "docker-compose.yml"), kongPort: 1, startedAt: "t", pid: process.pid }),
  )
}

const lastDevLocal = (): boolean | undefined => rendered.options.at(-1)?.devLocal

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "supatype-selfhost-mode-"))
  writeFileSync(join(projectDir, ".env"), "JWT_SECRET=an-operator-secret-that-is-at-least-32-characters\n")
  originalCwd = process.cwd()
  process.chdir(projectDir)
  docker.serverMode = undefined
  rendered.options.length = 0
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  process.chdir(originalCwd)
  vi.restoreAllMocks()
  rmSync(projectDir, { recursive: true, force: true })
})

describe("self-host compose commands keep the stack's mode (SH2)", () => {
  it("restart keeps a supatype dev stack dev while the session holds the lock", async () => {
    holdDevLock()
    await run("restart", "server")
    expect(lastDevLocal()).toBe(true)
  })

  it("up keeps a supatype dev stack dev while the session holds the lock", async () => {
    holdDevLock()
    await run("up")
    expect(lastDevLocal()).toBe(true)
  })

  it("restart keeps a running dev server dev when no lock is held", async () => {
    docker.serverMode = "dev"
    await run("restart", "server")
    expect(lastDevLocal()).toBe(true)
  })

  it("restart and up keep a standalone stack standalone", async () => {
    docker.serverMode = "standalone"
    await run("restart", "server")
    expect(lastDevLocal()).toBe(false)
    await run("up")
    expect(lastDevLocal()).toBe(false)
  })

  it("up starts a new stack as standalone", async () => {
    await run("up")
    expect(lastDevLocal()).toBe(false)
  })
})
