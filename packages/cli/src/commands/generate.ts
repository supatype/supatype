import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { connectionString, schemaPathFromToml } from "../config-toml.js"
import { ensureEngine, engineRequest } from "../engine-client.js"

export function registerGenerate(program: Command): void {
  program
    .command("generate")
    .description("Regenerate TypeScript types without running a migration")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (opts: { connection?: string }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const connection = opts.connection ?? connectionString(config)

      await ensureEngine()
      console.log("Loading schema...")
      const ast = loadSchemaAst(schemaPathFromToml(config, cwd), cwd)

      const body: Record<string, unknown> = { ast, lang: "typescript", database_url: connection }
      if (config.output?.types) body["types_path"] = config.output.types
      if (config.output?.client) body["client_path"] = config.output.client

      const result = await engineRequest<{ code?: string; message?: string }>("/generate", body)
      console.log(result.message ?? "Types generated.")
    })
}
