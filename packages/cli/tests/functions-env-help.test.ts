import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { registerFunctions } from "../src/commands/functions.js"

/**
 * A value set with `functions env set` arrives in `ctx.env` on each call and never in `Deno.env`.
 * The docs and the context type said so, but `--help`, where a user looks first, did not, and a
 * function reading `Deno.env.get` found nothing (review of round 7, item C11).
 */
function helpOf(...path: string[]): string {
  const program = new Command().name("supatype")
  registerFunctions(program)
  let command: Command = program
  for (const name of path) {
    const next = command.commands.find((sub) => sub.name() === name)
    if (next === undefined) throw new Error(`No command ${path.join(" ")}`)
    command = next
  }
  return command.helpInformation().replace(/\s+/g, " ")
}

describe("the functions env help", () => {
  for (const path of [["functions"], ["functions", "env"], ["functions", "env", "set"]]) {
    it(`says where values arrive in \`${path.join(" ")} --help\``, () => {
      const help = helpOf(...path)
      expect(help).toContain("ctx.env")
      expect(help).toMatch(/on each call, never in Deno\.env/)
    })
  }
})
