import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { hooksPathFromProject, schemaPathFromProject } from "../project-config.js"
import { writeHooksModule } from "../model-hooks.js"
import { writeGeneratedTypes } from "../type-generation.js"
import { error, info } from "../ui/messages.js"

export function registerGenerate(program: Command): void {
  program
    .command("generate")
    .description("Regenerate TypeScript types without running a migration")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (opts: { connection?: string }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const schemaPath = schemaPathFromProject(config, cwd)
      const outputTypesPath = config.output?.types ?? "types/database.ts"
      const outputClientPath = config.output?.client ?? "supatype/generated/index.d.ts"

      info("Loading schema...")
      const ast = loadSchemaAst(schemaPath, cwd)

      // Shared with push, which used to delegate the writing to the engine and produce no files.
      // Unlike push, this command always writes: the defaults above are the point of running it.
      try {
        const written = await writeGeneratedTypes({
          cwd,
          ast,
          typesPath: outputTypesPath,
          clientPath: outputClientPath,
        })
        for (const message of written) info(message)
      } catch (err) {
        error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }

      const hooksPath = writeHooksModule(cwd, hooksPathFromProject(config, cwd), ast)
      if (hooksPath !== null) info(`Hook handler types written to ${hooksPath}`)
    })
}
