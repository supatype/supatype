import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"
import { registerFunctions } from "../src/commands/functions.js"

/**
 * Review of round 7: `functions env` on a project with no link read the local env file line by line
 * with its own split, so an `export KEY=value` line, which the worker and compose read as KEY, was
 * listed as "export KEY", left in place by a set (which appended a second KEY) and kept by an unset.
 * The commands read and change the file as the dotenv parser reads it.
 */
let project: { dir: string; remove: () => void }
let envPath = ""

beforeEach(() => {
  project = tempProject("functions-env-local")
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" } }\n`,
  )
  mkdirSync(join(project.dir, "functions"), { recursive: true })
  envPath = join(project.dir, "functions", ".env.local")
  writeFileSync(envPath, "# shared\nexport API_KEY=old\nOTHER=2\n")
})

afterEach(() => {
  project.remove()
})

describe("functions env on a project with no link", () => {
  it("lists an exported variable by its name", async () => {
    const run = await runCommand(registerFunctions, ["functions", "env", "list"], project.dir)
    expect(run.output).toContain("  API_KEY = ")
    expect(run.output).not.toContain("export API_KEY")
  })

  it("replaces an exported variable rather than adding a second", async () => {
    await runCommand(registerFunctions, ["functions", "env", "set", "API_KEY=new"], project.dir)
    expect(readFileSync(envPath, "utf8")).toBe("# shared\nAPI_KEY=new\nOTHER=2\n")
  })

  it("removes an exported variable", async () => {
    await runCommand(registerFunctions, ["functions", "env", "unset", "API_KEY"], project.dir)
    expect(readFileSync(envPath, "utf8")).toBe("# shared\nOTHER=2\n")
  })

  it("says when the variable was not set", async () => {
    const run = await runCommand(registerFunctions, ["functions", "env", "unset", "NOPE"], project.dir)
    expect(run.output).toContain("NOPE was not set")
    expect(readFileSync(envPath, "utf8")).toBe("# shared\nexport API_KEY=old\nOTHER=2\n")
  })
})

// Issue 70: in a project with no functions directory, `env set` said "Setting FOO" and then failed
// with a raw ENOENT, because it wrote the file without creating its directory.
describe("functions env set with no functions directory", () => {
  it("creates the directory and the file with its header", async () => {
    const bare = tempProject("functions-env-bare")
    try {
      writeFileSync(
        join(bare.dir, "supatype.config.ts"),
        `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" } }\n`,
      )
      const run = await runCommand(registerFunctions, ["functions", "env", "set", "FOO=bar"], bare.dir)
      expect(run.output).not.toContain("ENOENT")
      const text = readFileSync(join(bare.dir, "functions", ".env.local"), "utf8")
      expect(text.startsWith("# Local environment variables for edge functions\n")).toBe(true)
      expect(text).toContain("FOO=bar\n")
    } finally {
      bare.remove()
    }
  })
})
