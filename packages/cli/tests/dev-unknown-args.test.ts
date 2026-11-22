import { Command, CommanderError } from "commander"
import { describe, expect, it, vi } from "vitest"
import { registerDev } from "../src/commands/dev.js"

/**
 * `supatype dev stop` is not a command, and `dev` takes no argument. It used to read the stray word
 * as nothing and start the whole stack, so someone trying to stop dev started it.
 */

function devProgram(): { program: Command; errors: string[] } {
  const errors: string[] = []
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeErr: (text) => errors.push(text), writeOut: () => {} })
  registerDev(program)
  return { program, errors }
}

describe("supatype dev with a stray argument", () => {
  it("refuses it and starts nothing", async () => {
    const { program, errors } = devProgram()
    const failure = await program.parseAsync(["node", "supatype", "dev", "stop"]).then(
      () => null,
      (err: unknown) => err,
    )
    expect(failure).toBeInstanceOf(CommanderError)
    expect(errors.join("")).toContain("too many arguments for 'dev'")
  })

  it("still accepts its own options", async () => {
    const { program } = devProgram()
    const dev = program.commands.find((c) => c.name() === "dev")
    expect(dev).toBeDefined()
    const seen = vi.fn()
    dev?.action(seen)
    await program.parseAsync(["node", "supatype", "dev", "--no-watch", "--port", "4000"])
    expect(seen).toHaveBeenCalledOnce()
  })
})
