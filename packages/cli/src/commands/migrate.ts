import type { Command } from "commander"
import { createInterface } from "node:readline"
import { loadConfig, loadSchemaAst } from "../config.js"
import { connectionString, schemaPathFromProject } from "../project-config.js"
import { ensureEngine, engineRequest } from "../engine-client.js"

export function registerMigrate(program: Command): void {
  // migrate — apply all pending migrations
  program
    .command("migrate")
    .description("Apply pending migrations from the migration history")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (opts: { connection?: string }) => {
      const config = loadConfig()
      const connection = opts.connection ?? connectionString(config)

      await ensureEngine()
      const result = await engineRequest<{ message?: string }>("/migrations", {
        database_url: connection,
        schema: "public",
        action: "pending",
      })
      console.log(result.message ?? "Migrations applied.")
    })

  // rollback — undo the last applied migration
  program
    .command("rollback")
    .description("Roll back the last applied migration")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (opts: { connection?: string }) => {
      const config = loadConfig()
      const connection = opts.connection ?? connectionString(config)

      await ensureEngine()
      const result = await engineRequest<{ message?: string }>("/migrations", {
        database_url: connection,
        schema: "public",
        action: "rollback",
      })
      console.log(result.message ?? "Rolled back.")
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
      const connection = opts.connection ?? connectionString(config)
      const cwd = process.cwd()

      await ensureEngine()
      const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)
      const result = await engineRequest<{ message?: string }>("/push", {
        ast,
        database_url: connection,
        schema: "public",
        force: true,
      })
      console.log(result.message ?? "Reset complete.")
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
