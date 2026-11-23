import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"
import { registerFunctions } from "../src/commands/functions.js"

/**
 * `functions env list|set|unset --function <name>` (decision D-77): one function's own values, which
 * override the shared ones. A linked self-hosted server serves them at /admin/v1/functions/<name>/env,
 * Supatype Cloud at /projects/<ref>/functions/<name>/env, and an unlinked project keeps them in the
 * functions directory's .env.<name>.local, the file the worker merges over .env.local.
 */
let project: { dir: string; remove: () => void }
let requests: { method: string; url: string; auth: string | null; body: string | undefined }[] = []
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
  project = tempProject("functions-env-function-scope")
  writeFileSync(join(project.dir, "supatype.config.ts"), CONFIG)
  vi.stubEnv("SUPATYPE_ACCESS_TOKEN", "cloud-token")
  requests = []
  answers = []
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : undefined
    requests.push({ method: init?.method ?? "GET", url: String(url), auth: new Headers(init?.headers).get("Authorization"), body })
    const answer = answers.shift() ?? { status: 200, body: { data: [] } }
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "Content-Type": "application/json" } }))
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  project.remove()
})

describe("env --function on a self-host link", () => {
  beforeEach(() => link("self-host"))

  it("lists a function's names from the admin API", async () => {
    answers.push({ status: 200, body: { data: ["API_KEY", "OTHER"] } })
    const run = await runCommand(registerFunctions, ["functions", "env", "list", "--function", "send-email"], project.dir)
    expect(run.exitCode).toBeUndefined()
    expect(requests.map(({ method, url, auth }) => ({ method, url, auth }))).toEqual([
      { method: "GET", url: "https://sh.example.test/admin/v1/functions/send-email/env", auth: "Bearer svc-key" },
    ])
    expect(run.output).toContain("API_KEY")
    expect(run.output).toContain("OTHER")
  })

  it("sets a value for the function", async () => {
    answers.push({ status: 200, body: { data: { key: "API_KEY", message: "set" } } })
    const run = await runCommand(registerFunctions, ["functions", "env", "set", "API_KEY=v", "--function", "send-email"], project.dir)
    expect(run.exitCode).toBeUndefined()
    expect(requests.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: "POST", url: "https://sh.example.test/admin/v1/functions/send-email/env", body: JSON.stringify({ key: "API_KEY", value: "v" }) },
    ])
    expect(run.output).toContain("Set API_KEY for function send-email on project acme.")
  })

  it("unsets a value, and says so when the server has no such key", async () => {
    answers.push({ status: 200, body: { data: { key: "API_KEY", message: "removed" } } })
    const removed = await runCommand(registerFunctions, ["functions", "env", "unset", "API_KEY", "--function", "send-email"], project.dir)
    expect(removed.output).toContain("Removed API_KEY for function send-email on project acme.")
    answers.push({ status: 404, body: { error: "key not found" } })
    const missing = await runCommand(registerFunctions, ["functions", "env", "unset", "NOPE", "--function", "send-email"], project.dir)
    expect(missing.exitCode).toBeUndefined()
    expect(missing.output).toContain("NOPE was not set for function send-email on project acme.")
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "DELETE https://sh.example.test/admin/v1/functions/send-email/env/API_KEY",
      "DELETE https://sh.example.test/admin/v1/functions/send-email/env/NOPE",
    ])
  })
})

describe("env --function on a Cloud link", () => {
  beforeEach(() => link("cloud"))

  it("uses the project's function env routes with the Cloud session", async () => {
    answers.push({ status: 200, body: { data: ["API_KEY"] } }, { status: 200, body: { data: {} } }, { status: 200, body: { data: { removed: true } } })
    await runCommand(registerFunctions, ["functions", "env", "list", "--function", "send-email"], project.dir)
    await runCommand(registerFunctions, ["functions", "env", "set", "API_KEY=v", "--function", "send-email"], project.dir)
    const unset = await runCommand(registerFunctions, ["functions", "env", "unset", "API_KEY", "--function", "send-email"], project.dir)
    expect(requests.map(({ method, url, auth }) => ({ method, url, auth }))).toEqual([
      { method: "GET", url: "https://api.example.test/api/v1/projects/acme/functions/send-email/env", auth: "Bearer cloud-token" },
      { method: "POST", url: "https://api.example.test/api/v1/projects/acme/functions/send-email/env", auth: "Bearer cloud-token" },
      { method: "DELETE", url: "https://api.example.test/api/v1/projects/acme/functions/send-email/env/API_KEY", auth: "Bearer cloud-token" },
    ])
    expect(requests[1]?.body).toBe(JSON.stringify({ key: "API_KEY", value: "v" }))
    expect(unset.output).toContain("Removed API_KEY for function send-email on project acme.")
  })
})

describe("env --function on a project that is not linked", () => {
  let functionsDir = ""
  beforeEach(() => {
    functionsDir = join(project.dir, "functions")
    mkdirSync(functionsDir, { recursive: true })
    writeFileSync(join(functionsDir, ".env.local"), "SHARED=1\n")
  })

  it("writes .env.<name>.local and leaves the shared file alone", async () => {
    const run = await runCommand(registerFunctions, ["functions", "env", "set", "API_KEY=v", "--function", "send-email"], project.dir)
    expect(run.exitCode).toBeUndefined()
    expect(readFileSync(join(functionsDir, ".env.send-email.local"), "utf8")).toContain("API_KEY=v")
    expect(readFileSync(join(functionsDir, ".env.local"), "utf8")).toBe("SHARED=1\n")
    expect(requests).toEqual([])
  })

  it("lists only that function's names", async () => {
    writeFileSync(join(functionsDir, ".env.send-email.local"), "API_KEY=v\n")
    const run = await runCommand(registerFunctions, ["functions", "env", "list", "--function", "send-email"], project.dir)
    expect(run.output).toContain("API_KEY")
    expect(run.output).not.toContain("SHARED")
  })

  it("says so when the function has no file yet", async () => {
    const run = await runCommand(registerFunctions, ["functions", "env", "list", "--function", "send-email"], project.dir)
    expect(run.exitCode).toBeUndefined()
    expect(run.output).toContain("No environment variables configured for function send-email.")
    expect(existsSync(join(functionsDir, ".env.send-email.local"))).toBe(false)
  })

  it("unsets from that function's file, even a name that breaks the rule", async () => {
    writeFileSync(join(functionsDir, ".env.send-email.local"), "OLD-NAME=1\nKEEP=2\n")
    const run = await runCommand(registerFunctions, ["functions", "env", "unset", "OLD-NAME", "--function", "send-email"], project.dir)
    expect(run.output).toContain("Removed OLD-NAME from function send-email's local env file.")
    expect(readFileSync(join(functionsDir, ".env.send-email.local"), "utf8")).toBe("KEEP=2\n")
    expect(readFileSync(join(functionsDir, ".env.local"), "utf8")).toBe("SHARED=1\n")
  })
})

describe("env --function refuses before doing anything", () => {
  it("a function name the control plane would refuse", async () => {
    link("self-host")
    const run = await runCommand(registerFunctions, ["functions", "env", "list", "--function", "SendEmail"], project.dir)
    expect(run.exitCode).toBe(1)
    expect(run.output).toContain(`"SendEmail" is not a valid function name`)
    expect(requests).toEqual([])
  })

  it("a secret name that breaks the rule, on set", async () => {
    link("self-host")
    const run = await runCommand(registerFunctions, ["functions", "env", "set", "MY-KEY=1", "--function", "send-email"], project.dir)
    expect(run.exitCode).toBe(1)
    expect(run.output).toContain(`"MY-KEY" is not a valid secret name`)
    expect(requests).toEqual([])
  })
})

describe("the --function help", () => {
  it.each(["list", "set", "unset"])("says a function's own value overrides a shared one in env %s", (sub) => {
    const program = new Command().name("supatype")
    registerFunctions(program)
    const env = program.commands.find((c) => c.name() === "functions")?.commands.find((c) => c.name() === "env")
    const help = env?.commands.find((c) => c.name() === sub)?.helpInformation().replace(/\s+/g, " ")
    expect(help).toMatch(/--function <name>.*overrides a shared one/)
  })
})
