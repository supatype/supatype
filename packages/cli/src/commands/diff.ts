import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { ensureEngine, invokeEngine } from "../engine.js"

interface DiffResult {
  operations: Array<{
    kind: string
    risk: "safe" | "cautious" | "destructive"
    description: string
  }>
}

export function registerDiff(program: Command): void {
  program
    .command("diff")
    .description("Show planned schema changes without applying them (dry run)")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (opts: { connection?: string }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const connection = opts.connection ?? config.connection

      await ensureEngine()

      console.log("Loading schema...")
      const ast = loadSchemaAst(config.schema, cwd)

      const result = invokeEngine(
        ["diff", "--connection", connection, "--format", "json"],
        JSON.stringify(ast),
      )
      if (result.exitCode !== 0) {
        console.error(result.stderr || result.stdout)
        process.exit(1)
      }

      const diff = JSON.parse(result.stdout) as DiffResult
      const ops = diff.operations ?? []

      if (ops.length === 0) {
        console.log("No changes.")
        return
      }

      const symbol = { safe: "+", cautious: "~", destructive: "!" }
      const legend = { safe: "safe", cautious: "cautious", destructive: "DESTRUCTIVE" }

      console.log(`\n${ops.length} change(s):\n`)
      for (const op of ops) {
        console.log(
          `  [${symbol[op.risk]}] ${op.description}  (${legend[op.risk]})`,
        )
      }

      const destructive = ops.filter((o) => o.risk === "destructive").length
      if (destructive > 0) {
        console.log(`\n  ${destructive} destructive operation(s). Run with --yes to skip confirmation.`)
      }
      console.log()
    })
}
