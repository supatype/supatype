import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"
import { registerFunctions } from "../src/commands/functions.js"

/**
 * Secret names follow one rule everywhere (decision D-65): letters, digits and underscore, not
 * starting with a digit. `env set` refuses a bad name before any request or file write; `env unset`
 * stays open so a key that already has a bad name can be cleaned up.
 */
let project: { dir: string; remove: () => void }
let envPath = ""

beforeEach(() => {
  project = tempProject("functions-env-name-rule")
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" } }\n`,
  )
  mkdirSync(join(project.dir, "functions"), { recursive: true })
  envPath = join(project.dir, "functions", ".env.local")
  writeFileSync(envPath, "OLD-NAME=1\nOTHER=2\n")
})

afterEach(() => {
  project.remove()
})

describe("functions env set name rule", () => {
  it.each(["MY-KEY=1", "1KEY=1", "a.b=1"])("refuses %s and writes nothing", async (pair) => {
    const run = await runCommand(registerFunctions, ["functions", "env", "set", pair], project.dir)
    expect(run.exitCode).toBe(1)
    expect(run.output).toContain(
      `"${pair.split("=")[0]}" is not a valid secret name: use letters, digits and underscore, and do not start with a digit.`,
    )
    expect(readFileSync(envPath, "utf8")).toBe("OLD-NAME=1\nOTHER=2\n")
  })

  it("still sets a valid name", async () => {
    const run = await runCommand(registerFunctions, ["functions", "env", "set", "GOOD_1=x"], project.dir)
    expect(run.exitCode).toBeUndefined()
    expect(readFileSync(envPath, "utf8")).toContain("GOOD_1=x")
  })

  // Unset is never held to the rule, so a key that already has a bad name can be cleaned up. The
  // dotenv parser does not read such a line as a variable, so unset matches the text before the `=`.
  it("removes a line whose name breaks the rule, and leaves every other line as it is", async () => {
    writeFileSync(envPath, "# note\nOLD-NAME=1\n  export OLD-NAME = 2\r\nOTHER=2\nOLD-NAME-2=3\n")
    const run = await runCommand(registerFunctions, ["functions", "env", "unset", "OLD-NAME"], project.dir)
    expect(run.exitCode).toBeUndefined()
    expect(run.output).not.toContain("not a valid secret name")
    expect(run.output).toContain("Removed OLD-NAME from local env file (2 lines).")
    expect(readFileSync(envPath, "utf8")).toBe("# note\nOTHER=2\nOLD-NAME-2=3\n")
  })

  it("says so when no line has the key", async () => {
    const run = await runCommand(registerFunctions, ["functions", "env", "unset", "NOPE-NAME"], project.dir)
    expect(run.output).toContain("NOPE-NAME was not set in the local env file.")
    expect(readFileSync(envPath, "utf8")).toBe("OLD-NAME=1\nOTHER=2\n")
  })
})
