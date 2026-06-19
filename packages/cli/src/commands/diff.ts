import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { resolveRuntimeProvider, schemaPathFromProject } from "../project-config.js"
import { printDiffOperations, printDiffWarnings } from "../diff-output.js"
import { resolveTarget, targetSchemaDiff, schemaPgSchema } from "../resolve-target.js"
import { loadProjectLink } from "../link.js"

export function registerDiff(program: Command): void {
  program
    .command("diff")
    .description("Show planned schema changes without applying them (dry run)")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option("--env <name>", "Target environment when linked")
    .option("--direct", "Use local engine subprocess")
    .action(async (opts: { connection?: string; env?: string; direct?: boolean }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const pgSchema = schemaPgSchema(cwd)

      console.log("Loading schema...")
      const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)

      const linked = loadProjectLink(cwd)
      const useDirect = opts.direct || Boolean(opts.connection)

      if (linked && !useDirect && !opts.connection) {
        const target = resolveTarget(cwd, { env: opts.env })
        const diff = await targetSchemaDiff(target, ast, { schema: pgSchema })
        printDiffWarnings(diff)
        printDiffOperations(diff)
        return
      }

      if (
        !opts.connection &&
        !useDirect &&
        resolveRuntimeProvider(config) === "docker"
      ) {
        const localTarget = resolveTarget(cwd, { env: opts.env })
        if (localTarget.mode === "local" && localTarget.token) {
          const diff = await targetSchemaDiff(localTarget, ast, { schema: pgSchema })
          printDiffWarnings(diff)
          printDiffOperations(diff)
          return
        }
        const { diffSchemaDocker } = await import("../dev-compose.js")
        const diff = await diffSchemaDocker(cwd, config)
        printDiffWarnings(diff)
        printDiffOperations(diff)
        return
      }

      const target = resolveTarget(cwd, {
        env: opts.env,
        direct: true,
        connection: opts.connection,
      })
      const diff = await targetSchemaDiff(target, ast, { schema: pgSchema })
      printDiffWarnings(diff)
      printDiffOperations(diff)
    })
}
