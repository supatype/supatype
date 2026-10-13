import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"

let projectConfig: SupatypeProjectConfig

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>()
  return { ...actual, loadConfig: () => projectConfig }
})

// Rendering itself is covered elsewhere; this is about what the command says around it.
vi.mock("../src/self-host-compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/self-host-compose.js")>()
  return {
    ...actual,
    writeSelfHostCompose: (cwd: string) => ({
      dir: cwd,
      composePath: join(cwd, "docker-compose.yml"),
      kongPath: join(cwd, "kong.yml"),
      s3ConfigPath: join(cwd, "s3.json"),
    }),
  }
})

import { registerSelfHost } from "../src/commands/self-host.js"

/**
 * `supatype self-host compose` renders a provider whose secret is set nowhere without a word, and the
 * deployment finds out at the first sign-in, as "missing OAuth secret" from the server. `dev` already
 * warns about exactly this; the deployment path is where it matters more.
 */
let projectDir = ""
let originalCwd = ""
let warnings: string[] = []

const withGithub = (): SupatypeProjectConfig => ({
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "standalone" },
  app: { mode: "none" },
  auth: { providers: { github: { clientId: "gh", secret: "env(GITHUB_SECRET)" } } },
})

async function render(): Promise<void> {
  const program = new Command().name("supatype").exitOverride()
  registerSelfHost(program)
  await program.parseAsync(["node", "supatype", "self-host", "compose", "render"])
}

beforeEach(() => {
  projectDir = join(tmpdir(), `supatype-selfhost-secrets-${process.pid}-${Date.now()}`)
  mkdirSync(projectDir, { recursive: true })
  originalCwd = process.cwd()
  process.chdir(projectDir)
  projectConfig = withGithub()
  // Unset rather than empty: an empty shell variable is a value compose would use over .env.
  vi.stubEnv("GITHUB_SECRET", undefined)
  vi.stubEnv("SUPATYPE_EXTERNAL_GITHUB_SECRET", undefined)
  warnings = []
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.join(" ")))
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  process.chdir(originalCwd)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(projectDir, { recursive: true, force: true })
})

describe("self-host compose and provider secrets", () => {
  it("warns when an enabled provider's secret is set nowhere", async () => {
    await render()
    expect(warnings.filter((line) => line.includes("GITHUB_SECRET"))).toHaveLength(1)
  })

  it("is quiet when .env holds the secret the config names", async () => {
    writeFileSync(join(projectDir, ".env"), "GITHUB_SECRET=from-dotenv\n")
    await render()
    expect(warnings.filter((line) => line.includes("GITHUB_SECRET"))).toEqual([])
  })

  it("is quiet when .env supplies the server's own variable instead", async () => {
    writeFileSync(join(projectDir, ".env"), "SUPATYPE_EXTERNAL_GITHUB_SECRET=from-dotenv\n")
    await render()
    expect(warnings).toEqual([])
  })
})
