import { mkdirSync, rmSync, writeFileSync } from "node:fs"
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

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>()
  return { ...actual, loadConfig: () => projectConfig }
})

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
        s3ConfigPath: join(cwd, "s3.json"),
      }
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

async function render(): Promise<void> {
  const program = new Command().name("supatype").exitOverride()
  registerSelfHost(program)
  await program.parseAsync(["node", "supatype", "self-host", "compose", "render"])
}

beforeEach(() => {
  projectDir = join(tmpdir(), `supatype-selfhost-urlsafe-${process.pid}-${Date.now()}`)
  mkdirSync(projectDir, { recursive: true })
  originalCwd = process.cwd()
  process.chdir(projectDir)
  rendered.length = 0
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
