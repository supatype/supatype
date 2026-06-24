import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { schemaPathFromProject } from "../project-config.js"
import { loadProjectLink } from "../link.js"
import { resolveTarget, targetSchemaAdopt, schemaPgSchema } from "../resolve-target.js"
import { confirm } from "../ui/confirm.js"
import { info, plain } from "../ui/messages.js"
import { withSpinner } from "../ui/progress.js"

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

      const ast = await withSpinner("Loading schema", async () =>
        loadSchemaAst(schemaPathFromProject(config, cwd), cwd),
      )

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
        info("Nothing to stamp — matching objects are already managed or absent.")
        return
      }

      plain(`\nWill stamp ${statements.length} object(s):\n`)
      for (const sql of statements) {
        plain(`  ${sql}`)
      }

      if (!opts.yes) {
        const ok = await confirm("Apply adoption stamps?", { default: false })
        if (!ok) {
          plain("Adoption cancelled.")
          return
        }
      }

      const result = (await targetSchemaAdopt(target, ast, {
        schema: pgSchema,
        noCache: opts.noCache ?? false,
        yes: true,
      })) as { status: string; stamped?: number; name?: string }

      info(`Adopted: ${result.stamped ?? 0} object(s) stamped (${result.name ?? "ok"}).`)
    })
}
