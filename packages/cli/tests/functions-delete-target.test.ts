import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"
import { registerFunctions } from "../src/commands/functions.js"

/**
 * `functions delete <name>`: a linked project, self-hosted or Cloud, deletes through the project's own
 * route (the self-host control plane removes the function's env file with its code), and a project
 * with no link has nothing to delete from and says so.
 */
let project: { dir: string; remove: () => void }
let requests: { method: string; url: string; auth: string | null }[] = []
let answers: { status: number; body: unknown }[] = []

const CONFIG = `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" } }\n`

function link(kind: "cloud" | "self-host"): void {
  mkdirSync(join(project.dir, ".supatype"), { recursive: true })
  const apiUrl = kind === "cloud" ? "https://api.example.test" : "https://sh.example.test"
  writeFileSync(
    join(project.dir, ".supatype", "link.json"),
    JSON.stringify({
      version: 1,
      kind,
      projectRef: "acme",
      defaultEnvironment: "production",
      ...(kind === "cloud" ? { cloudApiUrl: apiUrl } : {}),
      environments: { production: { name: "production", apiUrl, token: "svc-key", linkedAt: "2026-01-01T00:00:00Z" } },
    }),
  )
}

beforeEach(() => {
  project = tempProject("functions-delete-target")
  writeFileSync(join(project.dir, "supatype.config.ts"), CONFIG)
  vi.stubEnv("SUPATYPE_ACCESS_TOKEN", "cloud-token")
  requests = []
  answers = []
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    requests.push({ method: init?.method ?? "GET", url: String(url), auth: new Headers(init?.headers).get("Authorization") })
    const answer = answers.shift() ?? { status: 200, body: { data: {} } }
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "Content-Type": "application/json" } }))
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  project.remove()
})

describe("functions delete", () => {
  it("deletes through a self-host link's project route with its service-role key", async () => {
    link("self-host")
    const run = await runCommand(registerFunctions, ["functions", "delete", "send-email"], project.dir)
    expect(run.exitCode).toBeUndefined()
    expect(requests).toEqual([{ method: "DELETE", url: "https://sh.example.test/platform/v1/projects/acme/functions/send-email", auth: "Bearer svc-key" }])
    expect(run.output).toContain('Function "send-email" deleted')
  })

  it("says the server has no such function when it answers 404", async () => {
    link("self-host")
    answers.push({ status: 404, body: { error: "function not found" } })
    const run = await runCommand(registerFunctions, ["functions", "delete", "ghost"], project.dir)
    expect(run.exitCode).toBe(1)
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual(["DELETE https://sh.example.test/platform/v1/projects/acme/functions/ghost"])
    expect(run.output).toContain('Failed to delete "ghost"')
  })

  it("uses the project's route on Cloud", async () => {
    link("cloud")
    const run = await runCommand(registerFunctions, ["functions", "delete", "send-email"], project.dir)
    expect(run.exitCode).toBeUndefined()
    expect(requests).toEqual([{ method: "DELETE", url: "https://api.example.test/api/v1/projects/acme/functions/send-email", auth: "Bearer cloud-token" }])
    expect(run.output).toContain("It will return 404 immediately.")
  })

  it("refuses a name the server would refuse, before asking it", async () => {
    link("self-host")
    const run = await runCommand(registerFunctions, ["functions", "delete", "Bad Name"], project.dir)
    expect(run.exitCode).toBe(1)
    expect(requests).toEqual([])
    expect(run.output).toContain("is not a valid function name")
  })

  it("refuses on a project that is not linked, and deletes nothing", async () => {
    mkdirSync(join(project.dir, "functions", "hello"), { recursive: true })
    writeFileSync(join(project.dir, "functions", "hello", "index.ts"), "export default () => 1\n")
    const run = await runCommand(registerFunctions, ["functions", "delete", "hello"], project.dir)
    expect(run.exitCode).toBe(1)
    expect(requests).toEqual([])
    expect(run.output).toContain("Nothing was deleted")
    expect(run.output).toContain("supatype link")
  })
})
