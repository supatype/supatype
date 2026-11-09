import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LoadConfigOptions } from "../src/config.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Issue 24: every production command read `supatype.local.config.ts`, the developer's override, so a
 * self-host stack or a deploy ran with development settings. Each production command asks for the
 * config without it. The config load is where each is stopped: what it asked for is all this checks.
 */
const loads = vi.hoisted(() => ({
  options: [] as Array<LoadConfigOptions | undefined>,
  mode: "standalone" as "dev" | "standalone",
  /** The kind of project `supatype link` linked, or none. */
  link: null as "cloud" | "self-host" | null,
}))

vi.mock("../src/link.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/link.js")>()
  return {
    ...actual,
    loadProjectLink: () =>
      loads.link === null
        ? null
        : { version: 1, kind: loads.link, projectRef: "acme", defaultEnvironment: "production", environments: {} },
  }
})

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig: (_cwd?: string, options?: LoadConfigOptions) => {
    loads.options.push(options)
    // The first load of a push decides where it goes; a load without the override is the end.
    if (options?.local === false || loads.options.length > 1) throw new Error("loaded")
    return projectConfig({ provider: "docker" })
  },
}))
vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  composeRenderMode: () => loads.mode,
  // The stack runs, in that mode: a push to a stopped stack is refused before it loads more (issue 41).
  runningStackMode: () => loads.mode,
}))
// Its database runs too: a stack whose `db` was stopped is refused as well (issue 48).
vi.mock("../src/compose-kong.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-kong.js")>()),
  composeServiceIsRunning: () => true,
}))

const { registerSelfHost } = await import("../src/commands/self-host.js")
const { registerDeploy } = await import("../src/commands/deploy.js")
const { registerPush } = await import("../src/commands/push.js")

// The commands work in the current directory: an empty one, so whatever runs past the config
// load writes nothing into the package.
const home = process.cwd()
let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-production-config-"))
  process.chdir(dir)
  loads.options.length = 0
  loads.mode = "standalone"
  loads.link = null
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  process.chdir(home)
  rmSync(dir, { recursive: true, force: true })
})

/** Run `args`, returning the options each config load was given. */
async function run(args: string[]): Promise<Array<LoadConfigOptions | undefined>> {
  const program = new Command().exitOverride()
  registerSelfHost(program)
  registerDeploy(program)
  registerPush(program)
  await program.parseAsync(["node", "supatype", ...args]).catch((err: unknown) => {
    if (!(err instanceof Error) || err.message !== "loaded") throw err
  })
  return loads.options
}

describe("production commands read the config without the local override", () => {
  it.each([
    [["self-host", "compose", "render"]],
    [["self-host", "compose", "up"]],
    [["self-host", "compose", "down"]],
    [["self-host", "compose", "restart", "server"]],
    [["self-host", "compose", "status"]],
    [["self-host", "compose", "logs"]],
    [["self-host", "native", "install-service"]],
    [["self-host", "native", "serve"]],
    [["deploy"]],
  ])("%j", async (args) => {
    expect((await run(args)).at(-1)).toEqual({ local: false })
  })

  it("push, to a standalone stack", async () => {
    expect(await run(["push"])).toEqual([undefined, { local: false }])
  })

  it("push --env, to a linked self-host server", async () => {
    loads.link = "self-host"
    expect(await run(["push", "--env", "production"])).toEqual([undefined, { local: false }])
  })
})

describe("a push to a linked Supatype Cloud project", () => {
  it("is not taken for a self-host one", async () => {
    loads.link = "cloud"
    loads.mode = "dev"
    expect(await run(["push", "--env", "production"])).not.toContainEqual({ local: false })
  })
})

describe("development commands keep it", () => {
  it("push, to a stack dev holds", async () => {
    loads.mode = "dev"
    const options = await run(["push"])
    expect(options[0]).toBeUndefined()
    expect(options).not.toContainEqual({ local: false })
  })
})
