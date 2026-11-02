import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"
import { registerApp } from "../src/commands/app.js"
import * as gateway from "../src/local-gateway.js"
import { runCommand, tempProject } from "./support/command-run.js"

/**
 * `app add`, `status` and `functions serve` printed or used http://localhost:18473, the default
 * gateway port, whatever `.env`'s SUPATYPE_KONG_PORT said. `dev` moves Kong off 18473 when another
 * project holds it, and those commands then pointed at that other project's stack.
 */
let project: { dir: string; remove: () => void }

beforeEach(() => {
  project = tempProject("gateway-port")
  scaffold(project.dir, defaultScaffoldOptions("gw"))
  appendFileSync(join(project.dir, ".env"), "\nSUPATYPE_KONG_PORT=19000\n")
})

afterEach(() => {
  project.remove()
})

describe("the local gateway address commands print", () => {
  it("app add --static gives the app URL on .env's Kong port", async () => {
    const run = await runCommand(registerApp, ["app", "add", "--static"], project.dir)
    expect(run.output).toContain("App URL: http://localhost:19000/")
    expect(run.output).not.toContain("18473")
  })

  it("app add for a proxied app gives the app URL on .env's Kong port", async () => {
    const run = await runCommand(registerApp, ["app", "add", "--port", "5173"], project.dir)
    expect(run.output).toContain("app at http://localhost:19000/")
  })

  it("has one way to work out the address, which reads .env", () => {
    // localKongBaseUrl ignored .env; every caller now uses localPublicApiUrl.
    expect(Object.keys(gateway)).not.toContain("localKongBaseUrl")
    expect(gateway.localPublicApiUrl(project.dir)).toBe("http://localhost:19000")
  })
})
