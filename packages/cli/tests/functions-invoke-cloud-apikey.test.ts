import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"
import { registerFunctions } from "../src/commands/functions.js"

/**
 * A Cloud project's gateway refuses a request with no project API key: 401 `no_api_key`, and
 * `invalid_api_key` when the only credential is a Cloud session. `functions invoke` sent no key,
 * so the command the docs name for calling a deployed function could not call one.
 */
let project: { dir: string; remove: () => void }
let calls: { url: string; headers: Headers }[] = []

function linkToCloud(dir: string): void {
  mkdirSync(join(dir, ".supatype"), { recursive: true })
  writeFileSync(join(dir, ".supatype", "link.json"), JSON.stringify({
    version: 1,
    kind: "cloud",
    projectRef: "acme-ref",
    defaultEnvironment: "production",
    cloudApiUrl: "https://api.example.test",
    environments: { production: { name: "production", apiUrl: "https://acme-ref.example.test", linkedAt: "2026-01-01T00:00:00Z" } },
  }))
}

beforeEach(() => {
  project = tempProject("functions-invoke-cloud")
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" } }\n`,
  )
  linkToCloud(project.dir)
  vi.stubEnv("SUPATYPE_ACCESS_TOKEN", "cloud-session")
  calls = []
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const target = String(url)
    if (target === "https://acme-ref.example.test/supatype-env.json") {
      return Promise.resolve(new Response(JSON.stringify({ url: "https://acme-ref.example.test", anonKey: "anon-jwt" }), { headers: { "Content-Type": "application/json" } }))
    }
    if (target.endsWith("/environments/production/keys")) {
      return Promise.resolve(new Response(JSON.stringify({ anonKey: "anon-jwt", serviceRoleKey: "service-jwt" }), { headers: { "Content-Type": "application/json" } }))
    }
    calls.push({ url: target, headers: new Headers(init?.headers) })
    return Promise.resolve(new Response("{}", { status: 200 }))
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  project.remove()
})

describe("functions invoke on a Cloud link", () => {
  it("sends the environment's anon key as the apikey header", async () => {
    await runCommand(registerFunctions, ["functions", "invoke", "hello"], project.dir)
    expect(calls.map((c) => c.url)).toEqual(["https://acme-ref.example.test/functions/v1/hello"])
    expect(calls[0]?.headers.get("apikey")).toBe("anon-jwt")
    expect(calls[0]?.headers.get("Authorization")).toBeNull()
  })

  it("refuses --auth, saying what to do instead, and sends nothing to the function", async () => {
    const run = await runCommand(registerFunctions, ["functions", "invoke", "hello", "--auth"], project.dir)
    expect(run.exitCode).toBe(1)
    expect(run.output).toContain("--auth is not available on a Cloud link")
    expect(run.output).toContain("Cloud session")
    expect(run.output).toContain("signed-in user's access token")
    expect(calls).toEqual([])
  })

  it("never sends the Cloud session to the function, with or without --auth", async () => {
    await runCommand(registerFunctions, ["functions", "invoke", "hello", "--auth"], project.dir)
    await runCommand(registerFunctions, ["functions", "invoke", "hello"], project.dir)
    const sent = calls.flatMap((c) => [...c.headers.values()])
    expect(sent.some((v) => v.includes("cloud-session"))).toBe(false)
  })

  it("never sends the service role key", async () => {
    await runCommand(registerFunctions, ["functions", "invoke", "hello"], project.dir)
    expect(calls).toHaveLength(1)
    expect([...(calls[0]?.headers.values() ?? [])].some((v) => v.includes("service-jwt"))).toBe(false)
  })

  it("asks the control plane for the key when the environment does not publish one and a session is held", async () => {
    const base = globalThis.fetch
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      String(url).endsWith("/supatype-env.json") ? Promise.resolve(new Response("", { status: 404 })) : base(url, init))
    await runCommand(registerFunctions, ["functions", "invoke", "hello"], project.dir)
    expect(calls[0]?.headers.get("apikey")).toBe("anon-jwt")
  })

  it("ends saying why when the key cannot be had, sending nothing", async () => {
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) })
      return Promise.resolve(new Response(JSON.stringify({ message: "forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } }))
    })
    const run = await runCommand(registerFunctions, ["functions", "invoke", "hello"], project.dir)
    expect(run.exitCode).toBe(1)
    expect(run.output).toContain("anon key")
    expect(calls.some((c) => c.url.includes("/functions/v1/"))).toBe(false)
  })
})
