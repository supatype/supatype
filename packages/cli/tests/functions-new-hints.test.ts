import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ensureFunctionsDenoTypes } from "../src/functions-deno-types.js"
import { runCommand } from "./support/command-run.js"
import { registerFunctions } from "../src/commands/functions.js"

/**
 * Fresh-user test, cosmetic: `functions new` printed `exclude "functions" (or "functions")` and the
 * function it wrote linked https://supatype.com/docs/edge-functions, a page the docs do not have.
 */
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-fn-new-"))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("functions new", () => {
  it("names the functions directory once when there is no root tsconfig", () => {
    mkdirSync(join(dir, "functions"), { recursive: true })
    const { hints } = ensureFunctionsDenoTypes(dir, join(dir, "functions"))
    expect(hints.join("\n")).toContain('exclude "functions"')
    expect(hints.join("\n")).not.toContain("(or ")
  })

  it("writes no link to a docs page that does not exist", async () => {
    writeFileSync(
      join(dir, "supatype.config.ts"),
      `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" } }\n`,
    )
    await runCommand(registerFunctions, ["functions", "new", "hello"], dir)
    expect(readFileSync(join(dir, "functions", "hello", "index.ts"), "utf8")).not.toContain("docs/edge-functions")
  })
})
