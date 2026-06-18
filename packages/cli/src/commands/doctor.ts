import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { schemaPathFromProject } from "../project-config.js"
import { ensureEngine, engineRequest } from "../engine-client.js"
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
  console.log(`\n${title} (${items.length}):\n`)
  for (const item of items) {
    const fields = item.fields.length > 0 ? ` (${item.fields.join(", ")})` : ""
    console.log(`  • ${item.table}.${item.name}${fields}`)
    console.log(`    ${item.message}`)
  }
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Report schema drift between schema/index.ts and the live database")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option("--strict", "Exit non-zero when missing or stale managed drift exists")
    .option("--no-cache", "Force full database introspection")
    .action(async (opts: { connection?: string; strict?: boolean; noCache?: boolean }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const connection = await resolveHostEngineDatabaseUrl(cwd, config, opts.connection)
      const pgSchema = config.schema?.pg_schema ?? "public"

      await ensureEngine()

      console.log("Loading schema...")
      const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)

      const report = await engineRequest<DoctorReport>("/doctor", {
        ast,
        database_url: connection,
        schema: pgSchema,
        no_cache: opts.noCache ?? false,
      })

      printSection("Missing (in AST, not in DB)", report.missing ?? [])
      printSection("Stale managed (stamped, not in AST)", report.staleManaged ?? [])
      printSection("Unmanaged drift (manual decision)", report.unmanagedDrift ?? [])

      const missing = report.missing?.length ?? 0
      const stale = report.staleManaged?.length ?? 0
      const unmanaged = report.unmanagedDrift?.length ?? 0

      if (missing + stale + unmanaged === 0) {
        console.log("\nNo drift detected.")
      } else {
        console.log(`\nSummary: ${missing} missing, ${stale} stale managed, ${unmanaged} unmanaged`)
      }

      if (opts.strict && (missing > 0 || stale > 0)) {
        process.exit(1)
      }
    })
}
