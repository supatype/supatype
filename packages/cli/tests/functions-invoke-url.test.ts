import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"
import { registerFunctions } from "../src/commands/functions.js"

/**
 * `supatype functions invoke` has to call the project's own gateway.
 *
 * It called `http://localhost:54321` whatever the project was (fresh-user test B2), so on a
 * machine running another stack there the answer came from somebody else's gateway: a 503
 * "name resolution failed" for a function this project serves perfectly well on its own port.
 */
let project: { dir: string; remove: () => void }
let called: string[] = []
// The base URL of a `functions serve` that answers, as the worker answers a bare request.
let serving: string | undefined

beforeEach(() => {
  project = tempProject("functions-invoke")
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" } }\n`,
  )
  called = []
  serving = undefined
  vi.stubGlobal("fetch", (url: string) => {
    const target = String(url)
    if (target.startsWith("http://127.0.0.1:") && target.endsWith("/functions/v1/")) {
      if (serving === undefined || !target.startsWith(serving)) return Promise.reject(new TypeError("fetch failed"))
      return Promise.resolve(new Response(JSON.stringify({ error: "not_found", available: ["hello"] }), { status: 404 }))
    }
    called.push(target)
    return Promise.resolve(new Response("{}", { status: 200 }))
  })
  for (const key of ["SUPATYPE_URL", "SUPATYPE_API_URL", "PUBLIC_SUPATYPE_URL", "SITE_URL", "SUPATYPE_KONG_PORT"]) {
    vi.stubEnv(key, undefined)
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  project.remove()
})

describe("functions invoke", () => {
  it("calls the gateway port the project's .env names", async () => {
    writeFileSync(join(project.dir, ".env"), "SUPATYPE_KONG_PORT=18700\n")
    await runCommand(registerFunctions, ["functions", "invoke", "hello", "--local"], project.dir)
    expect(called).toEqual(["http://localhost:18700/functions/v1/hello"])
  })

  it("calls the project's own gateway when no cloud project is linked", async () => {
    writeFileSync(join(project.dir, ".env"), "PUBLIC_SUPATYPE_URL=http://localhost:18800\n")
    await runCommand(registerFunctions, ["functions", "invoke", "hello"], project.dir)
    expect(called).toEqual(["http://localhost:18800/functions/v1/hello"])
  })

  it("--local calls a running functions serve, on its default port", async () => {
    writeFileSync(join(project.dir, ".env"), "SUPATYPE_KONG_PORT=18700\n")
    serving = "http://127.0.0.1:18472"
    await runCommand(registerFunctions, ["functions", "invoke", "hello", "--local"], project.dir)
    expect(called).toEqual(["http://127.0.0.1:18472/functions/v1/hello"])
  })

  it("--local calls a functions serve on the port --port names", async () => {
    serving = "http://127.0.0.1:19123"
    await runCommand(registerFunctions, ["functions", "invoke", "hello", "--local", "--port", "19123"], project.dir)
    expect(called).toEqual(["http://127.0.0.1:19123/functions/v1/hello"])
  })

  it("--local falls back to the dev API when no functions serve answers", async () => {
    writeFileSync(join(project.dir, ".env"), "SUPATYPE_KONG_PORT=18700\n")
    await runCommand(registerFunctions, ["functions", "invoke", "hello", "--local", "--port", "19124"], project.dir)
    expect(called).toEqual(["http://localhost:18700/functions/v1/hello"])
  })

  // Issue 31's sibling: the compiled CLI's fetch (Bun) rejects a refused connection with a plain
  // Error, not Node's TypeError, so "Cannot reach" was never said and Bun's words were printed.
  it("says which address it could not reach when the compiled CLI's fetch is refused", async () => {
    writeFileSync(join(project.dir, ".env"), "SUPATYPE_KONG_PORT=18700\n")
    const bunRefused = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
      code: "ConnectionRefused",
    })
    vi.stubGlobal("fetch", () => Promise.reject(bunRefused))
    const run = await runCommand(registerFunctions, ["functions", "invoke", "hello"], project.dir)
    expect(run.output).toContain("Cannot reach http://localhost:18700/functions/v1/hello")
    expect(run.exitCode).toBe(1)
  })
})
