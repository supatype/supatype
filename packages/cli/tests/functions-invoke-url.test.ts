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

beforeEach(() => {
  project = tempProject("functions-invoke")
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" } }\n`,
  )
  called = []
  vi.stubGlobal("fetch", (url: string) => {
    called.push(String(url))
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
})
