import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { connectionString, resolveRuntimeProvider, schemaPathFromProject } from "../project-config.js"
import { ensureEngine, engineRequest, type DiffResult } from "../engine-client.js"
import { printDiffOperations, printDiffWarnings } from "../diff-output.js"

export function registerDiff(program: Command): void {
  program
    .command("diff")
    .description("Show planned schema changes without applying them (dry run)")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (opts: { connection?: string }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)

      // Docker provider: use compose unless a remote connection is configured.
      if (
        !opts.connection &&
        !config.connection?.trim() &&
        resolveRuntimeProvider(config) === "docker"
      ) {
        const { diffSchemaDocker } = await import("../dev-compose.js")
        console.log("Loading schema...")
        const diff = await diffSchemaDocker(cwd, config)
        printDiffWarnings(diff)
        printDiffOperations(diff)
        return
      }

      const connection = opts.connection ?? connectionString(config)
      const pgSchema = config.schema?.pg_schema ?? "public"

      await ensureEngine()

      console.log("Loading schema...")
      const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)

      const diff = await engineRequest<DiffResult>("/diff", {
        ast,
        database_url: connection,
        schema: pgSchema,
      })

      printDiffWarnings(diff)
      printDiffOperations(diff)
    })
}
