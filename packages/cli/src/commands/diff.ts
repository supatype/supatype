import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { connectionString, schemaPathFromProject } from "../project-config.js"
import { ensureEngine, engineRequest, type DiffResult } from "../engine-client.js"
import { printDiffWarnings } from "../diff-output.js"

export function registerDiff(program: Command): void {
  program
    .command("diff")
    .description("Show planned schema changes without applying them (dry run)")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (opts: { connection?: string }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const connection = opts.connection ?? connectionString(config)

      await ensureEngine()

      console.log("Loading schema...")
      const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)

      const diff = await engineRequest<DiffResult>("/diff", {
        ast,
        database_url: connection,
        schema: "public",
      })

      const ops = diff.operations ?? []
      printDiffWarnings(diff)

      if (ops.length === 0) {
        console.log("No changes.")
        return
      }

      const symbol: Record<NonNullable<DiffResult["operations"][number]["risk"]>, string> = {
        safe: "+",
        warn: "~",
        cautious: "~",
        danger: "!",
        destructive: "!",
      }
      const legend: typeof symbol = {
        safe: "safe",
        warn: "caution",
        cautious: "caution",
        danger: "DANGER",
        destructive: "DANGER",
      }

      console.log(`\n${ops.length} change(s):\n`)
      for (const op of ops) {
        const r = op.risk ?? "safe"
        console.log(`  [${symbol[r]}] ${op.description}  (${legend[r]})`)
      }

      const dangerous = ops.filter((o) => o.risk === "danger").length
      if (dangerous > 0) {
        console.log(`\n  ${dangerous} dangerous operation(s). Review before pushing.`)
      }
      console.log()
    })
}
