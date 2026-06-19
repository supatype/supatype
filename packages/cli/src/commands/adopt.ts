import type { Command } from "commander"
import { createInterface } from "node:readline"
import { loadConfig, loadSchemaAst } from "../config.js"
import { schemaPathFromProject } from "../project-config.js"
import { loadProjectLink } from "../link.js"
import { resolveTarget, targetSchemaAdopt, schemaPgSchema } from "../resolve-target.js"

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
    .option("--env <name>", "Target environment when linked")
    .option("--direct", "Use local engine subprocess")
    .option("--yes", "Apply stamps without interactive confirmation")
    .option("--no-cache", "Force full database introspection")
    .action(async (opts: {
      connection?: string
      env?: string
      direct?: boolean
      yes?: boolean
      noCache?: boolean
    }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const pgSchema = schemaPgSchema(cwd)

      console.log("Loading schema...")
      const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)

      const linked = loadProjectLink(cwd)
      const target = linked && !opts.direct && !opts.connection
        ? resolveTarget(cwd, { env: opts.env })
        : resolveTarget(cwd, { env: opts.env, direct: true, connection: opts.connection })

      const preview = (await targetSchemaAdopt(target, ast, {
        schema: pgSchema,
        noCache: opts.noCache ?? false,
        yes: false,
      })) as AdoptPreview

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

      const result = (await targetSchemaAdopt(target, ast, {
        schema: pgSchema,
        noCache: opts.noCache ?? false,
        yes: true,
      })) as { status: string; stamped?: number; name?: string }

      console.log(`\nAdopted: ${result.stamped ?? 0} object(s) stamped (${result.name ?? "ok"}).`)
    })
}
