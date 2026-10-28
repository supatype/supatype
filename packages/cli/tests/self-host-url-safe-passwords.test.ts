import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
const rendered: string[] = []
const composeRuns: string[][] = []
const composeFiles: string[] = []

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>()
  return { ...actual, loadConfig: () => projectConfig }
})

vi.mock("../src/self-host-compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/self-host-compose.js")>()
  return {
    ...actual,
    // The real writer, so the check it runs is the one under test, told what it would otherwise
    // look up in a schema these projects do not have.
    writeSelfHostCompose: (...[cwd, config, options]: Parameters<typeof actual.writeSelfHostCompose>) => {
      const paths = actual.writeSelfHostCompose(cwd, config, {
        ...options,
        fieldMaskingTier: "extension",
        drafts: false,
      })
      rendered.push(cwd)
      return paths
    },
    runDockerCompose: (path: string, args: string[]) => {
      composeFiles.push(path)
      composeRuns.push(args)
      return 0
    },
  }
})

import { registerSelfHost } from "../src/commands/self-host.js"

/**
 * The compose file puts POSTGRES_PASSWORD, AUTHENTICATOR_PASSWORD and the SQL editor's password
 * into connection URLs as `${VAR}`, which compose fills in unencoded. `render` and `up` refuse a
 * value that would break those URLs, before anything is written or started.
 */
let projectDir = ""
let originalCwd = ""
let errors: string[] = []

async function compose(...args: string[]): Promise<void> {
  const program = new Command().name("supatype").exitOverride()
  registerSelfHost(program)
  await program.parseAsync(["node", "supatype", "self-host", "compose", ...args])
}

const render = (): Promise<void> => compose("render")

beforeEach(() => {
  projectDir = join(tmpdir(), `supatype-selfhost-urlsafe-${process.pid}-${Date.now()}`)
  mkdirSync(projectDir, { recursive: true })
  originalCwd = process.cwd()
  process.chdir(projectDir)
  rendered.length = 0
  composeRuns.length = 0
  composeFiles.length = 0
  errors = []
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")))
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")))
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    throw new Error(`exit ${String(code)}`)
  })
})

afterEach(() => {
  process.chdir(originalCwd)
  vi.restoreAllMocks()
  rmSync(projectDir, { recursive: true, force: true })
})

describe("self-host compose render and URL-unsafe passwords", () => {
  it("refuses a password with @, naming the variable and how to make a safe one", async () => {
    writeFileSync(join(projectDir, ".env"), "POSTGRES_PASSWORD=p@ss\nAUTHENTICATOR_PASSWORD=ok\n")
    await expect(render()).rejects.toThrow("exit 1")
    const said = errors.join("\n")
    expect(said).toContain("POSTGRES_PASSWORD")
    expect(said).toContain("openssl rand -hex 24")
    expect(rendered).toEqual([])
  })

  it("renders when every password is URL-safe", async () => {
    writeFileSync(join(projectDir, ".env"), "POSTGRES_PASSWORD=abc-DEF_123\n")
    await render()
    expect(rendered).toHaveLength(1)
  })
})

const onDisk = (): string => join(projectDir, ".supatype", "self-host", "docker-compose.yml")

function composeFileOnDisk(): void {
  mkdirSync(join(projectDir, ".supatype", "self-host"), { recursive: true })
  writeFileSync(onDisk(), "services: {}\n")
}

/**
 * Only the commands that start or recreate containers check. A stack started by an older CLI with a
 * "/" in its password has to stay stoppable and inspectable through the file it was started from, or
 * the refusal strands it.
 */
describe("self-host compose commands that leave containers as they are", () => {
  beforeEach(() => {
    writeFileSync(join(projectDir, ".env"), "POSTGRES_PASSWORD=pa/ss\n")
    composeFileOnDisk()
  })

  it.each([
    [["down"], ["down"]],
    [["status"], ["ps"]],
    [["logs", "--service", "db"], ["logs", "-f", "db"]],
  ])("%j runs with a URL-unsafe password", async (command, expected) => {
    await compose(...command)
    expect(composeRuns).toEqual([expected])
  })

  it.each([[["restart", "db"]], [["up"]]])(
    "%j still refuses, since it recreates containers with that password",
    async (command) => {
      await expect(compose(...command)).rejects.toThrow("exit 1")
      expect(errors.join("\n")).toContain("POSTGRES_PASSWORD")
      expect(composeRuns).toEqual([])
    },
  )

  it("with no compose file on disk yet, renders one without refusing, since status starts nothing", async () => {
    rmSync(onDisk())
    await compose("status")
    expect(rendered).toHaveLength(1)
    expect(composeRuns).toEqual([["ps"]])
  })
})

/**
 * `supatype update`, a docker push or diff, and the dev watcher write the compose file too, and the
 * watcher does it inside a dev session, where exiting would kill the session. Only the commands that
 * start or recreate containers check, so the file writer itself never refuses.
 */
describe("writing the compose file", () => {
  it("does not refuse a URL-unsafe password, leaving that to the commands that start containers", async () => {
    writeFileSync(join(projectDir, ".env"), "POSTGRES_PASSWORD=pa/ss\n")
    const actual = await vi.importActual<typeof import("../src/self-host-compose.js")>("../src/self-host-compose.js")
    const options = { fieldMaskingTier: "extension", drafts: false } as const
    const paths = actual.writeSelfHostCompose(projectDir, projectConfig, options)
    expect(readFileSync(paths.composePath, "utf8")).toContain("services:")
  })
})

/**
 * `down`, `status` and `logs` act on the stack that is running, which was started from the compose
 * file on disk. Rewriting that file from the current config first is what made them run the checks a
 * new stack needs, and could point them at services the running stack does not have.
 */
describe("self-host compose commands that read the stack", () => {
  it.each([[["down"]], [["status"]], [["logs", "--service", "db"]]])(
    "%j runs against the compose file already on disk without rewriting it",
    async (command) => {
      composeFileOnDisk()
      await compose(...command)
      expect(rendered).toEqual([])
      expect(composeFiles).toEqual([onDisk()])
      expect(readFileSync(onDisk(), "utf8")).toBe("services: {}\n")
    },
  )

  it("renders the compose file when there is none on disk yet", async () => {
    await compose("status")
    expect(rendered).toHaveLength(1)
    expect(readFileSync(onDisk(), "utf8")).toContain("services:")
    expect(composeRuns).toEqual([["ps"]])
  })
})
