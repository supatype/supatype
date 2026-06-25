import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { info, plain } from "../ui/messages.js"
import { schemaPathFromProject } from "../project-config.js"
import { resolveTarget, targetSchemaDoctor, schemaPgSchema } from "../resolve-target.js"
import { loadProjectLink } from "../link.js"
import { resolveHostEngineDatabaseUrl } from "../dev-compose.js"

interface DoctorItem {
  kind: string
  table: string
  name: string
  fields: string[]
  message: string
}

interface DoctorReport {
  missing: DoctorItem[]
  staleManaged: DoctorItem[]
  unmanagedDrift: DoctorItem[]
}

function printSection(title: string, items: DoctorItem[]): void {
  if (items.length === 0) return
  plain(`\n${title} (${items.length}):\n`)
  for (const item of items) {
    const fields = item.fields.length > 0 ? ` (${item.fields.join(", ")})` : ""
    plain(`  • ${item.table}.${item.name}${fields}`)
    plain(`    ${item.message}`)
  }
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Report schema drift between schema/index.ts and the live database")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option("--env <name>", "Target environment when linked")
    .option("--strict", "Exit non-zero when missing or stale managed drift exists")
    .option("--no-cache", "Force full database introspection")
    .option("--direct", "Use local engine subprocess")
    .action(async (opts: {
      connection?: string
      env?: string
      strict?: boolean
      noCache?: boolean
      direct?: boolean
    }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const pgSchema = schemaPgSchema(cwd)

      info("Loading schema...")
      const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)

      let report: DoctorReport

      const linked = loadProjectLink(cwd)
      if (linked && !opts.direct && !opts.connection) {
        const target = resolveTarget(cwd, { env: opts.env })
        report = (await targetSchemaDoctor(target, ast, {
          noCache: opts.noCache,
          schema: pgSchema,
        })) as DoctorReport
      } else if (!opts.direct && !opts.connection) {
        const connection = await resolveHostEngineDatabaseUrl(cwd, config, opts.connection)
        const target = resolveTarget(cwd, { direct: true, connection })
        report = (await targetSchemaDoctor(target, ast, {
          noCache: opts.noCache,
          schema: pgSchema,
        })) as DoctorReport
        void connection
      } else {
        const target = resolveTarget(cwd, {
          env: opts.env,
          direct: true,
          connection: opts.connection,
        })
        report = (await targetSchemaDoctor(target, ast, {
          noCache: opts.noCache,
          schema: pgSchema,
        })) as DoctorReport
      }

      printSection("Missing (in AST, not in DB)", report.missing ?? [])
      printSection("Stale managed (stamped, not in AST)", report.staleManaged ?? [])
      printSection("Unmanaged drift (manual decision)", report.unmanagedDrift ?? [])

      const missing = report.missing?.length ?? 0
      const stale = report.staleManaged?.length ?? 0
      const unmanaged = report.unmanagedDrift?.length ?? 0

      if (missing + stale + unmanaged === 0) {
        info("No drift detected.")
      } else {
        plain(`\nSummary: ${missing} missing, ${stale} stale managed, ${unmanaged} unmanaged`)
      }

      if (opts.strict && (missing > 0 || stale > 0)) {
        process.exit(1)
      }
    })
}
