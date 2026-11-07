import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * Issue 58: in a project whose supatype.config.ts keeps the scaffold's
 * `environments: { default: "production" }`, `envs use staging` said "Default environment set to
 * staging" and `envs list` showed `Default: staging`, while every command went on to production,
 * which the config names first. `envs` now names the default commands use, and says where it is set.
 */

const project = vi.hoisted(() => ({ config: undefined as SupatypeProjectConfig | undefined }))
vi.mock("../src/local-stack-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/local-stack-guard.js")>()),
  projectConfigIfAny: () => project.config,
}))

const said = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[], plain: [] as string[] }))
vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  info: (message: string) => said.info.push(message),
  warn: (message: string) => said.warn.push(message),
  plain: (message = "") => said.plain.push(message),
}))

const { registerEnvs } = await import("../src/commands/link-helpers.js")
const { loadProjectLink, saveProjectLink } = await import("../src/link.js")

const BASE: SupatypeProjectConfig = {
  project: { name: "rc091b" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "standalone" },
  app: { mode: "none" },
}
const target = (name: string) => ({ name, apiUrl: `https://${name}.example.test`, linkedAt: "2026-11-07T00:00:00Z" })

let dir = ""
let cwd: () => string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-envs-"))
  cwd = process.cwd
  process.cwd = () => dir
  saveProjectLink(dir, {
    version: 1,
    kind: "self-host",
    projectRef: "rc091b",
    defaultEnvironment: "production",
    environments: { production: target("production"), staging: target("staging") },
  })
  said.info.length = 0
  said.warn.length = 0
  said.plain.length = 0
})
afterEach(() => {
  process.cwd = cwd
  rmSync(dir, { recursive: true, force: true })
})

async function envs(...args: string[]): Promise<void> {
  const program = new Command().exitOverride()
  registerEnvs(program)
  await program.parseAsync(["node", "supatype", "envs", ...args])
}

describe("envs with environments.default in the config", () => {
  beforeEach(() => {
    project.config = { ...BASE, environments: { default: "production" } }
  })

  it("use saves the choice but says the config's default still wins", async () => {
    await envs("use", "staging")
    expect(loadProjectLink(dir)?.defaultEnvironment).toBe("staging")
    expect(said.info).toEqual([])
    expect(said.warn.join("\n")).toMatch(/environments names "production", and commands use that first/)
  })

  it("list names the default commands use, and where it is set", async () => {
    await envs("use", "staging")
    await envs("list")
    expect(said.plain).toContain("Default: production (from supatype.config.ts environments)\n")
    expect(said.plain.some((line) => line.startsWith(" * production"))).toBe(true)
  })
})

// Round 2 of the retest: with production named by the config but not linked, `envs list` starred
// nothing and gave no next step.
describe("envs list when the default is not linked", () => {
  it("says so, and how to link it", async () => {
    project.config = { ...BASE, environments: { default: "qa" } }
    await envs("list")
    expect(said.plain).toContain("Default: qa (from supatype.config.ts environments, not linked: run supatype link --env qa)\n")
    expect(said.plain.some((line) => line.startsWith(" *"))).toBe(false)
  })
})

describe("envs with no default in the config", () => {
  beforeEach(() => {
    project.config = BASE
  })

  it("use sets the default commands use", async () => {
    await envs("use", "staging")
    expect(said.info).toEqual(['Default environment set to "staging".'])
    await envs("list")
    expect(said.plain).toContain("Default: staging\n")
  })
})
