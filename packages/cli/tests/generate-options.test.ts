import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { registerGenerate } from "../src/commands/generate.js"

/**
 * `supatype generate` writes types from the schema file through the engine and never opens a
 * database, so a `--connection` it accepted was silently ignored. It is refused instead.
 */

function program(): { root: Command; help: () => string } {
  const root = new Command("supatype").exitOverride()
  let out = ""
  root.configureOutput({ writeOut: (s) => { out += s }, writeErr: () => undefined })
  registerGenerate(root)
  return { root, help: () => out }
}

describe("supatype generate", () => {
  it("does not offer --connection", async () => {
    const { root, help } = program()
    await expect(root.parseAsync(["generate", "--help"], { from: "user" })).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    })
    expect(help()).toContain("Regenerate TypeScript types")
    expect(help()).not.toContain("--connection")
  })

  it("refuses --connection as an unknown option", async () => {
    const { root } = program()
    await expect(
      root.parseAsync(["generate", "--connection", "postgres://x"], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.unknownOption" })
  })
})
