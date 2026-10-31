import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"
import { registerFunctions } from "../src/commands/functions.js"

/**
 * `functions logs` on a project linked to a self-hosted server. It asked Supatype Cloud
 * (api.supatype.com) whatever the link named, and read once, so a self-host user saw a login
 * error or nothing. It tails the linked server's relay of the worker's log stream instead.
 */
let project: { dir: string; remove: () => void }
let requests: { url: string; auth: string | null; signal: AbortSignal | undefined }[] = []

const event = (fn: string, message: string): string =>
  `data: ${JSON.stringify({ timestamp: "2026-10-30T12:00:01.000Z", level: "info", service: "functions-worker", project_ref: "acme", function: fn, message })}\n\n`

beforeEach(() => {
  project = tempProject("functions-logs")
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" } }\n`,
  )
  mkdirSync(join(project.dir, ".supatype"), { recursive: true })
  writeFileSync(join(project.dir, ".supatype", "link.json"), JSON.stringify({
    version: 1,
    kind: "self-host",
    projectRef: "acme",
    defaultEnvironment: "production",
    environments: { production: { name: "production", apiUrl: "https://sh.example.test", token: "svc-key", linkedAt: "2026-01-01T00:00:00Z" } },
  }))
  requests = []
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization"), signal: init?.signal ?? undefined })
    const body = "retry: 2000\n\n" + event("hello", "first") + event("other", "not this one") + event("hello", "second")
    return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  project.remove()
})

describe("functions logs on a self-host link", () => {
  it("tails the linked server with its service-role key, showing only that function", async () => {
    const run = await runCommand(registerFunctions, ["functions", "logs", "hello"], project.dir)
    expect(requests.map(({ url, auth }) => ({ url, auth }))).toEqual([{ url: "https://sh.example.test/admin/v1/functions/logs/tail", auth: "Bearer svc-key" }])
    // A tail runs until Ctrl+C: no timeout cuts it off.
    expect(requests[0]?.signal).toBeUndefined()
    expect(run.output).toContain("first")
    expect(run.output).toContain("second")
    expect(run.output).not.toContain("not this one")
  })
})

// Every functions command resolves the same linked target. invoke used to send a self-host-linked
// project to https://<ref>.supatype.dev with the Cloud token.
describe("functions invoke on a self-host link", () => {
  it("calls the linked server, never Supatype Cloud, and never sends the Cloud token", async () => {
    vi.stubEnv("SUPATYPE_ACCESS_TOKEN", "cloud-token")
    try {
      await runCommand(registerFunctions, ["functions", "invoke", "hello"], project.dir)
    } finally {
      vi.unstubAllEnvs()
    }
    expect(requests.map((r) => r.url)).toEqual(["https://sh.example.test/functions/v1/hello"])
    expect(requests.some((r) => r.url.includes("supatype.dev") || r.auth === "Bearer cloud-token")).toBe(false)
  })
})

// Review of round 5: with no token of its own for a self-hosted server, `invoke --auth` sent the
// placeholder JWT meant for local testing to that server.
describe("functions invoke --auth on a self-host link", () => {
  it("refuses, sending nothing, rather than send a placeholder token to the server", async () => {
    const run = await runCommand(registerFunctions, ["functions", "invoke", "hello", "--auth"], project.dir)
    expect(run.exitCode).toBe(1)
    expect(run.output).toContain("--auth")
    expect(requests).toEqual([])
  })
})

// Review of round 5: on targetFetch these commands had no timeout, and waited forever on a stalled
// target. They give up after 10 s again.
describe("a functions request to the linked target", () => {
  it("gives up after a while", async () => {
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), auth: null, signal: init?.signal ?? undefined })
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { headers: { "Content-Type": "application/json" } }))
    })
    await runCommand(registerFunctions, ["functions", "list"], project.dir)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal)
  })
})
