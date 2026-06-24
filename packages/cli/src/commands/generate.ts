import type { Command } from "commander"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { loadConfig, loadSchemaAst } from "../config.js"
import { schemaPathFromProject } from "../project-config.js"
import { ensureEngine, engineRequest } from "../engine-client.js"
import { generateClientAugmentation } from "../augmentation-generator.js"
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

      await ensureEngine()
      info("Loading schema...")
      const ast = loadSchemaAst(schemaPath, cwd)

      const result = await engineRequest<{ code?: string; message?: string }>("/generate", { ast, lang: "typescript" })

      const typesCode = result.code ?? result.message
      if (typesCode === undefined) {
        error("Engine returned no output.")
        process.exit(1)
      }

      const outPath = resolve(cwd, outputTypesPath)
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, typesCode, "utf8")
      info(`Types written to ${outputTypesPath}`)

      const augmentationOutPath = resolve(cwd, outputClientPath)
      const augmentationCode = generateClientAugmentation(ast)
      mkdirSync(dirname(augmentationOutPath), { recursive: true })
      writeFileSync(augmentationOutPath, augmentationCode, "utf8")
      info(`Client augmentation written to ${outputClientPath}`)
    })
}
