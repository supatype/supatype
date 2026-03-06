import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { invokeEngine } from "../engine.js"

export function registerGenerate(program: Command): void {
  program
    .command("generate")
    .description("Regenerate TypeScript types without running a migration")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action((opts: { connection?: string }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const connection = opts.connection ?? config.connection

      console.log("Loading schema...")
      const ast = loadSchemaAst(config.schema, cwd)

      const args = ["generate", "--connection", connection]
      if (config.output?.types) args.push("--types", config.output.types)
      if (config.output?.client) args.push("--client", config.output.client)

      const result = invokeEngine(args, JSON.stringify(ast))
      if (result.exitCode !== 0) {
        console.error(result.stderr || result.stdout)
        process.exit(1)
      }

      console.log(result.stdout || "Types generated.")
    })
}
