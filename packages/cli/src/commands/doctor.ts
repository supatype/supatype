import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { error, info, plain } from "../ui/messages.js"
import { askConsent } from "../ui/confirm.js"
import { isAccessKind } from "../diff-output.js"
import { hooksPathFromProject, schemaPathFromProject, serviceRoleRoutes } from "../project-config.js"
import { requireTargetFeatures, resolveTarget, targetSchemaDoctor, schemaPgSchema, type DeployTarget } from "../resolve-target.js"
import { loadProjectLink } from "../link.js"
import { resolveHostEngineDatabaseUrl } from "../dev-compose.js"
import { hooksReport, type HooksReport } from "../model-hooks.js"
import { checkServiceRoleRoutes, type ServiceRoleProblems } from "../service-role-check.js"
import { addRetiredNoCacheOption, warnIfRetiredNoCache } from "../retired-no-cache.js"

export interface DoctorItem {
  kind: string
  table: string
  name: string
  fields: string[]
  message: string
  /** What Supatype recorded, for a drifted object. */
  recorded?: string
  /** What the database holds now, for a drifted or conflicting object. */
  live?: string
}

/**
 * The engine's reconcile, sorted for an operator. The optional categories arrived with the
 * managed-object ledger, so an older engine omits them; `rebaselined` is only there after
 * `--rebaseline`.
 */
export interface DoctorReport {
  missing: DoctorItem[]
  staleManaged: DoctorItem[]
  unmanagedDrift: DoctorItem[]
  drifted?: DoctorItem[]
  conflicting?: DoctorItem[]
  released?: DoctorItem[]
  rebaselined?: DoctorItem[]
}

type Category = keyof DoctorReport

/** Each category, its heading, and its word in the summary line, in the order they print. */
const SECTIONS: ReadonlyArray<{ key: Category; title: string; summary: string }> = [
  { key: "missing", title: "Missing (declared, not in the database)", summary: "missing" },
  { key: "drifted", title: "Drifted (changed outside Supatype)", summary: "drifted" },
  { key: "staleManaged", title: "Stale managed (Supatype's, no longer declared)", summary: "stale managed" },
  { key: "conflicting", title: "Conflicting (a declared name held by someone else)", summary: "conflicting" },
  { key: "unmanagedDrift", title: "Unmanaged (not Supatype's, left in place)", summary: "unmanaged" },
  { key: "released", title: "Released (left alone after `adopt --release`)", summary: "released" },
  { key: "rebaselined", title: "Rebaselined (recorded as they are now)", summary: "rebaselined" },
]

/** What a push would change or refuse: what `--strict` fails on, the engine's own rule. */
const STRICT: ReadonlySet<Category> = new Set(["missing", "staleManaged", "drifted", "conflicting"])

const itemsOf = (report: DoctorReport, key: Category): DoctorItem[] => report[key] ?? []

export function hasStrictIssues(report: DoctorReport): boolean {
  return [...STRICT].some((key) => itemsOf(report, key).length > 0)
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
    if (item.recorded !== undefined) plain(`    recorded: ${item.recorded}`)
    if (item.live !== undefined) plain(`    live:     ${item.live}`)
  }
}

/** Every section, then one summary line. Exported for tests. */
export function printReport(report: DoctorReport): void {
  for (const { key, title } of SECTIONS) printSection(title, itemsOf(report, key))
  const counts = SECTIONS.map(({ key, summary }) => ({ n: itemsOf(report, key).length, summary }))
  if (counts.every(({ n }) => n === 0)) {
    info("No drift detected.")
    return
  }
  const parts = counts.filter(({ n }) => n > 0).map(({ n, summary }) => `${n} ${summary}`)
  plain(`\nSummary: ${parts.join(", ")}`)
}

/**
 * What `doctor --rebaseline` would record, from a report taken without it: every drifted object,
 * except access drift (policies, grants, labels, RLS) unless `--overwrite-drift` says to take a hand
 * edit to who may read or write as Supatype's too. Exported for tests.
 */
export function rebaselinePlan(
  report: DoctorReport,
  overwriteDrift: boolean,
): { record: DoctorItem[]; kept: DoctorItem[] } {
  const drifted = report.drifted ?? []
  if (overwriteDrift) return { record: drifted, kept: [] }
  return {
    record: drifted.filter((item) => !isAccessKind(item.kind)),
    kept: drifted.filter((item) => isAccessKind(item.kind)),
  }
}

/** The preview a person approves before a rebaseline. Exported for tests. */
export function printRebaselinePlan(plan: { record: DoctorItem[]; kept: DoctorItem[] }): void {
  printSection("Rebaseline will record these as they are now, changing no object", plan.record)
  printSection(
    "Left drifted: access changed outside Supatype (pass --overwrite-drift to record these too)",
    plan.kept,
  )
}

interface DoctorOptions {
  connection?: string
  env?: string
  strict?: boolean
  rebaseline?: boolean
  overwriteDrift?: boolean
  yes?: boolean
  cache?: boolean
  direct?: boolean
}

export function registerDoctor(program: Command): void {
  const command = program
    .command("doctor")
    .description("Report schema drift between schema/index.ts and the live database")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option("--env <name>", "Target environment when linked")
    .option("--strict", "Exit non-zero when a push would change or refuse something")
    .option(
      "--rebaseline",
      "Record drifted objects as they are now, changing no object (after a Postgres upgrade, or to keep a hand edit until the schema changes it); shows them and asks first",
    )
    .option(
      "--overwrite-drift",
      "With --rebaseline, also record policies, grants, labels and RLS changed outside Supatype",
    )
    .option("--yes", "Rebaseline without asking")
    .option("--direct", "Use local engine subprocess")
  addRetiredNoCacheOption(command).action(doctor)
}

async function doctor(opts: DoctorOptions): Promise<void> {
  warnIfRetiredNoCache(opts)
  const cwd = process.cwd()
  const config = loadConfig(cwd)
  const pgSchema = schemaPgSchema(cwd)
  const rebaseline = opts.rebaseline === true
  const overwriteDrift = opts.overwriteDrift === true

  if (overwriteDrift && !rebaseline) {
    error("doctor --overwrite-drift only applies with --rebaseline")
    process.exit(1)
  }

  info("Loading schema...")
  const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)

  const target = await schemaCommandTarget(cwd, config, opts)
  await requireTargetFeatures(target, [
    ...(rebaseline ? [{ feature: "rebaseline", flag: "--rebaseline" } as const] : []),
    ...(overwriteDrift ? [{ feature: "overwrite_drift", flag: "--overwrite-drift" } as const] : []),
  ])
  let report = (await targetSchemaDoctor(target, ast, { schema: pgSchema })) as DoctorReport

  printHooks(hooksReport(cwd, hooksPathFromProject(config, cwd), ast))
  printServiceRoleGrants(checkServiceRoleRoutes(config, cwd), serviceRoleRoutes(config))

  if (rebaseline) {
    // Plan 3.2: a rebaseline takes what the database holds as Supatype's from now on, so a person
    // sees each object first, and a hand edit to access is taken only with --overwrite-drift too.
    const plan = rebaselinePlan(report, overwriteDrift)
    if (plan.record.length === 0) {
      printReport(report)
      // Access drift alone is still drift: say why it was not recorded and how it would be.
      printRebaselinePlan(plan)
      info("Nothing to rebaseline.")
    } else {
      printRebaselinePlan(plan)
      const consent = await askConsent(
        `Record ${plan.record.length} object(s) as Supatype's baseline?`,
        opts.yes ?? false,
      )
      if (consent === "needs-yes") {
        error("doctor --rebaseline needs --yes when not interactive")
        process.exitCode = 1
        return
      }
      if (consent === "declined") {
        plain("Rebaseline cancelled. Nothing was recorded.")
        printReport(report)
      } else {
        report = (await targetSchemaDoctor(target, ast, {
          schema: pgSchema,
          rebaseline: true,
          overwriteDrift,
        })) as DoctorReport
        printReport(report)
      }
    }
  } else {
    printReport(report)
  }

  if (opts.strict && hasStrictIssues(report)) {
    process.exit(1)
  }
}

/**
 * Where `doctor` and `adopt` look: the linked environment, else the local dev database, unless
 * `--direct` or `--connection` asks for the engine subprocess. One answer for both, so `adopt` takes
 * exactly what `doctor` reported.
 */
export async function schemaCommandTarget(
  cwd: string,
  config: ReturnType<typeof loadConfig>,
  opts: { connection?: string; env?: string; direct?: boolean },
): Promise<DeployTarget> {
  if (opts.direct || opts.connection) {
    return resolveTarget(cwd, { env: opts.env, direct: true, connection: opts.connection })
  }
  if (loadProjectLink(cwd)) return resolveTarget(cwd, { env: opts.env })
  const connection = await resolveHostEngineDatabaseUrl(cwd, config, undefined)
  return resolveTarget(cwd, { direct: true, connection })
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
