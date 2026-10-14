import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Command } from "commander"
import * as config from "../src/config.js"

// One run's project name, over the config file's, without writing anything: two runs of one project
// from two checkouts (the live test scripts) need two compose projects, and the old way there was a
// generated supatype.local.config.ts, which a killed run left behind along with the name it carried.

const ENV = "SUPATYPE_PROJECT_NAME"
let dir: string
let saved: string | undefined

beforeEach(() => {
  dir = join(tmpdir(), `st-project-name-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "supatype.config.ts"),
    `export default ${JSON.stringify({
      project: { name: "example" },
      database: { provider: "docker" },
      server: { mode: "dev" },
      app: { mode: "none" },
    })}\n`,
  )
  saved = process.env[ENV]
  delete process.env[ENV]
})

afterEach(() => {
  if (saved === undefined) delete process.env[ENV]
  else process.env[ENV] = saved
  rmSync(dir, { recursive: true, force: true })
})

describe("SUPATYPE_PROJECT_NAME", () => {
  it("names the project for the run, over the config file", () => {
    process.env[ENV] = "run-b2"
    expect(config.loadConfig(dir).project.name).toBe("run-b2")
  })

  it("writes no file to do it", () => {
    process.env[ENV] = "run-b2"
    config.loadConfig(dir)
    expect(readdirSync(dir)).toEqual(["supatype.config.ts"])
  })

  it("leaves the file's name reachable, for state that outlives the run", () => {
    process.env[ENV] = "run-b2"
    const cfg = config.loadConfig(dir)
    expect(config.projectNameInFile(cfg)).toBe("example")
  })

  it("changes nothing when unset", () => {
    const cfg = config.loadConfig(dir)
    expect(cfg.project.name).toBe("example")
    expect(config.projectNameInFile(cfg)).toBe("example")
  })

  it("refuses a name compose would rewrite", () => {
    process.env[ENV] = "Run B"
    expect(() => config.loadConfig(dir)).toThrow(/SUPATYPE_PROJECT_NAME/)
  })
})

describe("--project-name", () => {
  it("sets the run's project name before any command runs", async () => {
    let seen: string | undefined
    const program = new Command().exitOverride()
    config.registerProjectNameOption(program)
    program.command("dev").action(() => {
      seen = config.loadConfig(dir).project.name
    })
    await program.parseAsync(["node", "supatype", "dev", "--project-name", "run-c"])
    expect(seen).toBe("run-c")
  })

  it("is taken before the command too", async () => {
    let seen: string | undefined
    const program = new Command().exitOverride()
    config.registerProjectNameOption(program)
    program.command("push").action(() => {
      seen = config.loadConfig(dir).project.name
    })
    await program.parseAsync(["node", "supatype", "--project-name", "run-d", "push"])
    expect(seen).toBe("run-d")
  })
})
