import type { Command } from "commander"
import { createInterface } from "node:readline"
import { loadConfig } from "../config.js"
import { ensureEngine, invokeEngine } from "../engine.js"

export function registerMigrate(program: Command): void {
  // migrate — apply all pending migrations
  program
    .command("migrate")
    .description("Apply pending migrations from the migration history")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (opts: { connection?: string }) => {
      const config = loadConfig()
      const connection = opts.connection ?? config.connection

      await ensureEngine()
      const result = invokeEngine(["migrate", "--pending", "--connection", connection])
      if (result.exitCode !== 0) {
        console.error(result.stderr || result.stdout)
        process.exit(1)
      }
      console.log(result.stdout || "Migrations applied.")
    })

  // rollback — undo the last applied migration
  program
    .command("rollback")
    .description("Roll back the last applied migration")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (opts: { connection?: string }) => {
      const config = loadConfig()
      const connection = opts.connection ?? config.connection

      await ensureEngine()
      const result = invokeEngine(["rollback", "--connection", connection])
      if (result.exitCode !== 0) {
        console.error(result.stderr || result.stdout)
        process.exit(1)
      }
      console.log(result.stdout || "Rolled back.")
    })

  // reset — drop all tables and re-apply from scratch
  program
    .command("reset")
    .description(
      "Drop all managed tables and re-apply the schema from scratch (destructive)",
    )
    .option("--yes", "Skip confirmation prompt")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (opts: { yes?: boolean; connection?: string }) => {
      if (!opts.yes) {
        const confirmed = await confirm(
          "This will DROP all managed tables and re-apply the schema. Proceed? [y/N] ",
        )
        if (!confirmed) {
          console.log("Aborted.")
          return
        }
      }

      const config = loadConfig()
      const connection = opts.connection ?? config.connection

      await ensureEngine()
      const result = invokeEngine(["reset", "--connection", connection])
      if (result.exitCode !== 0) {
        console.error(result.stderr || result.stdout)
        process.exit(1)
      }
      console.log(result.stdout || "Reset complete.")
    })
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === "y")
    })
  })
}
