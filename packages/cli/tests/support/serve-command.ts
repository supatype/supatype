import { Command } from "commander"
import { registerFunctions } from "../../src/commands/functions.js"

/** `supatype functions serve` as registered, for reading its options and their defaults. */
export function serveCommand(): Command | undefined {
  const program = new Command()
  registerFunctions(program)
  return program.commands.find((c) => c.name() === "functions")?.commands.find((c) => c.name() === "serve")
}
