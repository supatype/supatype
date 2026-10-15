import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"

let fakeHome = ""

// Cloud credentials live under the home directory; every test gets its own.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => (fakeHome.length > 0 ? fakeHome : actual.homedir()) }
})

import { registerFunctions } from "../src/commands/functions.js"

/**
 * What `supatype functions` tells someone to run next has to be a command that exists.
 *
 * It named `supatype self-host compose restart` before that subcommand existed, then a raw
 * `docker compose ... restart` after it did, and `npx supatype cloud login` / `cloud link`, which
 * are `supatype login` and `supatype link`. It also
 * looked for a session in `~/.supatype/token`, a file nothing writes, so a user who had just run
 * `supatype login` was told they were not logged in.
 */
let project: { dir: string; remove: () => void }

function writeConfig(dir: string): void {
  writeFileSync(
    join(dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" } }\n`,
  )
}

function writeFunction(dir: string): void {
  mkdirSync(join(dir, "functions", "hello"), { recursive: true })
  writeFileSync(join(dir, "functions", "hello", "index.ts"), "export default () => new Response('hi')\n")
}

function linkToCloud(dir: string): void {
  mkdirSync(join(dir, ".supatype"), { recursive: true })
  const link = {
    version: 1,
    kind: "cloud",
    projectRef: "acme-ref",
    defaultEnvironment: "production",
    cloudApiUrl: "https://api.example.test",
    environments: { production: { name: "production", apiUrl: "https://api.example.test", linkedAt: "2026-01-01T00:00:00Z" } },
  }
  writeFileSync(join(dir, ".supatype", "link.json"), JSON.stringify(link))
}

beforeEach(() => {
  project = tempProject("functions-hints")
  fakeHome = join(project.dir, "home")
  mkdirSync(join(fakeHome, ".supatype"), { recursive: true })
  vi.stubEnv("SUPATYPE_ACCESS_TOKEN", undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  project.remove()
  fakeHome = ""
})

describe("functions deploy on a self-host compose stack", () => {
  it("tells you a restart command that exists", async () => {
    writeConfig(project.dir)
    writeFunction(project.dir)
    mkdirSync(join(project.dir, ".supatype", "self-host"), { recursive: true })
    writeFileSync(join(project.dir, ".supatype", "self-host", "docker-compose.yml"), "services: {}\n")

    const run = await runCommand(registerFunctions, ["functions", "deploy"], project.dir)

    // The CLI's own command, which recreates the service with the current config and .env.
    expect(run.output).toContain("supatype self-host compose restart functions-worker")
    expect(run.output).not.toContain("docker compose -p")
  })
})

describe("functions commands against a cloud link", () => {
  it("names supatype login, not a cloud subcommand that does not exist", async () => {
    linkToCloud(project.dir)
    const run = await runCommand(registerFunctions, ["functions", "list"], project.dir)

    expect(run.exitCode).toBe(1)
    expect(run.output).toContain("Not logged in. Run: supatype login")
    expect(run.output).not.toContain("cloud login")
  })

  it("uses the session supatype login saved", async () => {
    linkToCloud(project.dir)
    writeFileSync(
      join(fakeHome, ".supatype", "credentials.json"),
      JSON.stringify({ apiUrl: "https://api.example.test", accessToken: "saved-by-login" }),
    )
    const seen: string[] = []
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("Authorization") ?? "")
      return new Response(JSON.stringify({ data: [] }), { headers: { "Content-Type": "application/json" } })
    })

    const run = await runCommand(registerFunctions, ["functions", "list"], project.dir)

    expect(run.output).not.toContain("Not logged in")
    expect(seen).toEqual(["Bearer saved-by-login"])
  })

  it("names supatype link when the project is not linked", async () => {
    writeFunction(project.dir)
    const run = await runCommand(registerFunctions, ["functions", "delete", "hello"], project.dir)

    expect(run.output).toContain("No linked project. Run: supatype link")
    expect(run.output).not.toContain("cloud link")
  })
})
