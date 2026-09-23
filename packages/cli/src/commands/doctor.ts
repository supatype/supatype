import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { info, plain } from "../ui/messages.js"
import { hooksPathFromProject, schemaPathFromProject, serviceRoleRoutes } from "../project-config.js"
import { resolveTarget, targetSchemaDoctor, schemaPgSchema } from "../resolve-target.js"
import { loadProjectLink } from "../link.js"
import { resolveHostEngineDatabaseUrl } from "../dev-compose.js"
import { hooksReport, type HooksReport } from "../model-hooks.js"
import { checkServiceRoleRoutes, type ServiceRoleProblems } from "../service-role-check.js"

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

/** Exported for tests: the label form is easy to get subtly wrong per item kind. */
export function printSection(title: string, items: DoctorItem[]): void {
  if (items.length === 0) return
  plain(`\n${title} (${items.length}):\n`)
  for (const item of items) {
    const fields = item.fields.length > 0 ? ` (${item.fields.join(", ")})` : ""
    // A table's `name` *is* its table, so the usual `table.name` form renders "widget.widget".
    const label = item.table === item.name ? item.name : `${item.table}.${item.name}`
    plain(`  • ${label}${fields}`)
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

      printHooks(hooksReport(cwd, hooksPathFromProject(config, cwd), ast))
      printServiceRoleGrants(checkServiceRoleRoutes(config, cwd), serviceRoleRoutes(config))

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

/**
 * Whether declared hooks can actually run.
 *
 * Worth its own section because every failure here is silent: a hook whose function is missing, or a
 * stack with functions switched off, produces no error anywhere, the write just succeeds
 * unvalidated. Drift you cannot see is the thing doctor exists for.
 */
/**
 * Field validators, reported separately from hooks because the consequence differs.
 *
 * A hook that never fires is a step that did not happen. A validator that never fires would be a
 * field written unchecked, so the server refuses the write instead: these fields cannot be saved at
 * all until the function exists, and the line has to say that rather than imply a silent gap.
 */
function printFieldValidators(report: HooksReport): void {
  if (report.validators.length === 0) return

  plain(`\nField validators (${report.validators.length}):\n`)
  for (const entry of report.validators) {
    const broken = report.validatorsMissing.some(
      (m) => m.model === entry.model && m.field === entry.field,
    )
    plain(`  ${broken ? "✗" : "•"} ${entry.model}.${entry.field} → ${entry.function}`)
  }

  if (report.validatorsMissing.length > 0) {
    plain("\n  Those marked ✗ name a function that does not exist. An unreachable validator refuses")
    plain("  the write, so these fields cannot be saved until the function is created.")
    plain("  Create it with: supatype hooks new <name>")
  }
  if (report.validatorMapMissing) {
    plain("\n  .supatype/manifest.json carries no validator map, so no field is being checked.")
    plain("  Run: supatype push")
  }
}

export function printHooks(report: HooksReport): void {
  printFieldValidators(report)
  if (report.declared.length === 0) return

  plain(`\nHooks (${report.declared.length}):\n`)
  for (const hook of report.declared) {
    const broken = report.missing.some(
      (m) => m.model === hook.model && m.event === hook.event,
    )
    plain(`  ${broken ? "✗" : "•"} ${hook.model}.${hook.event} → ${hook.function}`)
  }

  if (report.missing.length > 0) {
    plain("\n  Those marked ✗ name a function that does not exist, so they never fire.")
    plain("  Create it with: supatype hooks new <name>")
  }
  if (report.functionsDisabled) {
    plain("\n  functions_enabled is false in .supatype/manifest.json, every hook is inert.")
    plain("  Regenerate the stack config with: supatype self-host compose")
  }
  if (report.mapMissing) {
    plain("\n  .supatype/manifest.json carries no hook map, so the server has nothing to call.")
    plain("  Run: supatype push")
  }
}

/**
 * Report which functions may see the service-role key, and which grants do nothing.
 *
 * Worth printing even when everything resolves: this is the list of functions that can read and write
 * past every access rule in the schema, and "which ones are those again?" should be answerable without
 * opening the config.
 */
export function printServiceRoleGrants(
  problems: ServiceRoleProblems,
  declared: readonly string[],
): void {
  if (declared.length === 0) return

  plain(`\nService-role grants (${declared.length}):\n`)
  const broken = new Set(problems.missing)
  for (const name of declared) {
    plain(`  ${broken.has(name) ? "✗" : "•"} ${name}`)
  }

  if (broken.size > 0) {
    plain("\n  Those marked ✗ match no function, so they grant nothing, the function reads no key.")
  }
  for (const warning of problems.warnings) plain(warning)
  plain("\n  These functions bypass every access rule in the schema. Anything not listed cannot.")
}
