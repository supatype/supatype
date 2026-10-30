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

  it("names the directory functions.path points at, not a fixed functions/", async () => {
    writeFileSync(
      join(project.dir, "supatype.config.ts"),
      `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" }, functions: { path: "api/edge" } }\n`,
    )
    mkdirSync(join(project.dir, "api", "edge", "hello"), { recursive: true })
    writeFileSync(join(project.dir, "api", "edge", "hello", "index.ts"), "export default () => new Response('hi')\n")
    mkdirSync(join(project.dir, ".supatype", "self-host"), { recursive: true })
    writeFileSync(join(project.dir, ".supatype", "self-host", "docker-compose.yml"), "services: {}\n")

    const run = await runCommand(registerFunctions, ["functions", "deploy"], project.dir)

    expect(run.output).toMatch(/Functions are served from api[\\/]edge\/ in your project/)
    expect(run.output).not.toContain("functions/ directory")
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

// Local test round 3c (N17): every function failed, and deploy still said `Deployed 1 function(s)`,
// printed the invoke URL and exited 0.
describe("functions deploy to Cloud when a function fails", () => {
  function linkAndLogIn(): void {
    writeConfig(project.dir)
    writeFunction(project.dir)
    mkdirSync(join(project.dir, "functions", "bye"), { recursive: true })
    writeFileSync(join(project.dir, "functions", "bye", "index.ts"), "export default () => new Response('bye')\n")
    linkToCloud(project.dir)
    vi.stubEnv("SUPATYPE_ACCESS_TOKEN", "token")
  }

  function platformRefusing(name: string): void {
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? "")
      if (body.includes(`"name":"${name}"`)) {
        return new Response(JSON.stringify({ error: "bundle too large" }), { status: 422 })
      }
      return new Response(JSON.stringify({ data: {} }), { headers: { "Content-Type": "application/json" } })
    })
  }

  it("names the failed function, counts only those deployed, and exits non-zero", async () => {
    linkAndLogIn()
    platformRefusing("bye")

    const run = await runCommand(registerFunctions, ["functions", "deploy"], project.dir)

    expect(run.output).toContain("bye ✗ HTTP 422: bundle too large")
    expect(run.output).toContain("1 of 2 function(s) failed to deploy: bye")
    expect(run.output).not.toContain("Deployed 2 function(s)")
    expect(run.exitCode).toBe(1)
  })

  it("says every function deployed and exits 0 when none failed", async () => {
    linkAndLogIn()
    platformRefusing("none")

    const run = await runCommand(registerFunctions, ["functions", "deploy"], project.dir)

    expect(run.output).toContain("Deployed 2 function(s)")
    expect(run.exitCode ?? 0).toBe(0)
  })
})
