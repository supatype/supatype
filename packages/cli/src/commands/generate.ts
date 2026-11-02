import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { hooksPathFromProject, schemaPathFromProject } from "../project-config.js"
import { writeHooksModule } from "../model-hooks.js"
import { ENGINE_FALLBACK, generatedFilesEngine } from "../generated-files-engine.js"
import { projectOutputPaths, writeGeneratedTypes } from "../type-generation.js"
import { error, info } from "../ui/messages.js"
import { errorMessage } from "../error-message.js"

export function registerGenerate(program: Command): void {
  program
    .command("generate")
    .description("Regenerate TypeScript types without running a migration")
    .action(async () => {
      info("Loading schema...")
      try {
        for (const message of await regenerateTypes(process.cwd())) info(message)
      } catch (err) {
        error(errorMessage(err))
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
  // The host engine, as Docker dev's refresh uses it, the image only when it cannot be fetched
  // (generated-files-engine.ts). Shared with push, which used to delegate the writing to the engine
  // and produce no files.
  const choice = await generatedFilesEngine(cwd, config)
  const written = await writeGeneratedTypes({ cwd, ast, ...projectOutputPaths(config.output), engine: choice.engine })
  if (choice.fellBack !== undefined) console.warn(`[supatype] ${ENGINE_FALLBACK}: ${choice.fellBack}`)
  const hooksPath = writeHooksModule(cwd, hooksPathFromProject(config, cwd), ast)
  return hooksPath === null ? written : [...written, `Hook handler types written to ${hooksPath}`]
}
