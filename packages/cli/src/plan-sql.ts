import { engineMigrationSql } from "./commands/migrate.js"
import { plannedChanges } from "./diff-output.js"
import type { DiffResult } from "./engine-client.js"
import { resolveHostDatabaseUrl } from "./host-database.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import type { DeployTarget } from "./resolve-target.js"
import { plain, warn } from "./ui/messages.js"
import { withSpinner } from "./ui/progress.js"

/** Where the SQL of a plan is written from: the project, the target it goes to, and the schema. */
export interface PlanSqlSource {
  cwd: string
  config: SupatypeProjectConfig
  target: Pick<DeployTarget, "mode" | "environment" | "databaseUrl">
  ast: unknown
  schema: string
  /** `--connection`, when one was named. */
  connection?: string | undefined
}

/** The plan's SQL, or why this target cannot write it. */
export interface PlanSql {
  sql?: string
  reason?: string
}

/** The target as the person knows it, for the line that says it cannot print SQL. */
function remoteName(target: Pick<DeployTarget, "mode" | "environment">): string {
  return target.mode === "cloud" ? `Supatype Cloud (${target.environment})` : `the self-hosted server (${target.environment})`
}

/**
 * The SQL a push to `source.target` would apply. A database this machine reaches is asked of the
 * engine, as `supatype migrate` does. A linked self-host server and Supatype Cloud have no endpoint
 * that writes SQL without applying it, so they answer with why instead.
 */
export async function planSqlOrReason(source: PlanSqlSource): Promise<PlanSql> {
  const { target } = source
  if (target.mode === "cloud" || target.mode === "self-host") {
    return {
      reason:
        `${remoteName(target)} cannot print the SQL: its API has no endpoint that writes it without applying it. ` +
        "The change list above is what it reports. Run `supatype migrate` against a local database to see the SQL.",
    }
  }
  const dsn =
    target.databaseUrl ?? resolveHostDatabaseUrl(source.cwd, source.config, { connection: source.connection, allowDerived: true }).dsn
  const sql = await engineMigrationSql(source.cwd, source.config, {
    ast: source.ast,
    dsn,
    connection: source.connection,
    schema: source.schema,
    // A dry run shows a destructive change with its risk comment, so nothing is held back for want of a yes.
    opts: { force: true },
  })
  return { sql }
}

/**
 * After the change list: the SQL of the plan, or that there is none to run, or why this target
 * cannot print it. Applies nothing.
 */
export async function printPlanSql(diff: DiffResult, source: PlanSqlSource): Promise<void> {
  if (plannedChanges(diff).length === 0) {
    plain("\nNo changes, so there is no SQL to run.")
    return
  }
  const plan = await withSpinner("Writing the SQL", () => planSqlOrReason(source))
  if (plan.sql !== undefined) plain(`\nSQL that would be applied:\n\n${plan.sql}`)
  else if (plan.reason !== undefined) warn(plan.reason)
}
