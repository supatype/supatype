import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { projectConfig } from "./support/project-config.js"

/**
 * `supatype admin` in a folder linked to a self-host project fell through to the local Docker stack
 * and said it was not running, as if the link were not there. It now refuses and names the link.
 * The link is a real `.supatype/link.json`; only the config and the stack guard are stood in for.
 */
const guard = vi.hoisted(() => ({ calls: [] as string[], running: false }))

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig: () => projectConfig({ project: { name: "acme" }, provider: "docker", database: { provider: "docker" } }),
}))
vi.mock("../src/local-stack-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/local-stack-guard.js")>()),
  requireLocalStack: (_cwd: string, _config: unknown, command: string) => {
    guard.calls.push(command)
    if (!guard.running) throw new NoStackRunning(command)
  },
}))
vi.mock("../src/host-database.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/host-database.js")>()),
  resolveHostDatabaseUrl: () => ({ dsn: "postgresql://x@127.0.0.1:1/none" }),
}))

const { registerAdmin } = await import("../src/commands/admin.js")
const { NoStackRunning } = await import("../src/host-database.js")

let dir: string
let previous: string

function linkAs(kind: "self-host" | "cloud"): void {
  mkdirSync(join(dir, ".supatype"), { recursive: true })
  const environment = { name: "production", apiUrl: "https://api.acme.example.test", linkedAt: "2026-11-01T00:00:00Z" }
  writeFileSync(
    join(dir, ".supatype", "link.json"),
    JSON.stringify({
      version: 1,
      kind,
      projectRef: "acme-prod",
      defaultEnvironment: "production",
      environments: { production: environment },
    }),
  )
}

async function run(...args: string[]): Promise<void> {
  const program = new Command().exitOverride()
  registerAdmin(program)
  await program.parseAsync(["node", "supatype", "admin", ...args])
}

beforeEach(() => {
  guard.calls.length = 0
  previous = process.cwd()
  dir = mkdtempSync(join(tmpdir(), "admin-link-"))
  process.chdir(dir)
})

afterEach(() => {
  process.chdir(previous)
  rmSync(dir, { recursive: true, force: true })
})

describe("supatype admin on a self-host link with no local stack", () => {
  it.each([["list-users"], ["set-role", "--email", "a@b.test", "--role", "editor"]])(
    "%s refuses, naming the link and the API URL, not the local stack",
    async (...args) => {
      linkAs("self-host")
      await expect(run(...args)).rejects.toThrow(/self-host project "acme-prod" \(https:\/\/api\.acme\.example\.test\)/)
    },
  )

  it("says the local stack is not running when the folder is not linked", async () => {
    await expect(run("list-users")).rejects.toThrow(NoStackRunning)
  })

  it("leaves a Cloud link's own refusal alone", async () => {
    linkAs("cloud")
    await expect(run("list-users")).rejects.not.toThrow(/self-host project/)
  })
})
