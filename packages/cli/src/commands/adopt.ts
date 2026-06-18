import type { Command } from "commander"
import { createInterface } from "node:readline"
import { loadConfig, loadSchemaAst } from "../config.js"
import { schemaPathFromProject } from "../project-config.js"
import { ensureEngine, engineRequest } from "../engine-client.js"
import { resolveHostEngineDatabaseUrl } from "../dev-compose.js"

interface AdoptPreview {
  status: string
  stampStatements?: string[]
  doctor?: {
    missing: unknown[]
    staleManaged: unknown[]
    unmanagedDrift: unknown[]
  }
}

export function registerAdopt(program: Command): void {
  program
    .command("adopt")
    .description("Stamp Supatype-managed comments on DB objects matching the schema (adoption ceremony)")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option("--yes", "Apply stamps without interactive confirmation")
    .option("--no-cache", "Force full database introspection")
    .action(async (opts: { connection?: string; yes?: boolean; noCache?: boolean }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const connection = await resolveHostEngineDatabaseUrl(cwd, config, opts.connection)
      const pgSchema = config.schema?.pg_schema ?? "public"

      await ensureEngine()

      console.log("Loading schema...")
      const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)

      const preview = await engineRequest<AdoptPreview>("/adopt", {
        ast,
        database_url: connection,
        schema: pgSchema,
        no_cache: opts.noCache ?? false,
        yes: false,
      })

      const statements = preview.stampStatements ?? []
      if (statements.length === 0) {
        console.log("Nothing to stamp — matching objects are already managed or absent.")
        return
      }

      console.log(`\nWill stamp ${statements.length} object(s):\n`)
      for (const sql of statements) {
        console.log(`  ${sql}`)
      }

      if (!opts.yes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        const answer = await new Promise<string>((resolve) => {
          rl.question("\nApply adoption stamps? [y/N] ", resolve)
        })
        rl.close()
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.log("Adoption cancelled.")
          return
        }
      }

      const result = await engineRequest<{ status: string; stamped?: number; name?: string }>(
        "/adopt",
        {
          ast,
          database_url: connection,
          schema: pgSchema,
          no_cache: opts.noCache ?? false,
          yes: true,
        },
      )

      console.log(`\nAdopted: ${result.stamped ?? 0} object(s) stamped (${result.name ?? "ok"}).`)
    })
}
