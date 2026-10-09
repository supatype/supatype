import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { hooksPathFromProject, schemaPathFromProject } from "../project-config.js"
import { writeHooksModule } from "../model-hooks.js"
import {
  DEFAULT_CLIENT_PATH,
  DEFAULT_TYPES_PATH,
  writeGeneratedTypes,
} from "../type-generation.js"
import { error, info } from "../ui/messages.js"

export function registerGenerate(program: Command): void {
  program
    .command("generate")
    .description("Regenerate TypeScript types without running a migration")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (_opts: { connection?: string }) => {
      info("Loading schema...")
      try {
        for (const message of await regenerateTypes(process.cwd())) info(message)
      } catch (err) {
        error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })
}

/**
 * What `supatype generate` writes: the generated types and client, and the hook handler types.
 * The messages to print; throws when the types cannot be written. `adopt` runs it after declaring
 * an adopted column.
 */
export async function regenerateTypes(cwd: string): Promise<string[]> {
  const config = loadConfig(cwd)
  const schemaPath = schemaPathFromProject(config, cwd)
  const ast = loadSchemaAst(schemaPath, cwd)
  // Shared with push, which used to delegate the writing to the engine and produce no files.
  // Unlike push, this command always writes: the defaults are the point of running it.
  const written = await writeGeneratedTypes({
    cwd,
    ast,
    typesPath: config.output?.types ?? DEFAULT_TYPES_PATH,
    clientPath: config.output?.client ?? DEFAULT_CLIENT_PATH,
  })
  const hooksPath = writeHooksModule(cwd, hooksPathFromProject(config, cwd), ast)
  return hooksPath === null ? written : [...written, `Hook handler types written to ${hooksPath}`]
}
