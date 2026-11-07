/**
 * Database connection commands:
 *   supatype db connection-string: show the connection string for the linked project
 *   supatype db reset-password: reset the database password
 *   supatype db check: does this database meet what Supatype needs of it?
 */

import { projectConfigIfAny } from "../local-stack-guard.js"
import type { Command } from "commander"
import { errorMessage } from "../error-message.js"
import { DatabaseConnectFailed, withDatabase } from "../db-rows.js"
import type { Client } from "pg"
import { loadConfig, rethrowIfConfigBroken } from "../config.js"
import { NoStackRunning, resolveHostDatabaseUrl, type ResolvedDsn } from "../host-database.js"
import type { SupatypeProjectConfig } from "../project-config.js"
import { loadProjectLink } from "../link.js"
import { resolveTarget } from "../resolve-target.js"
import { targetFetch } from "../target-client.js"
import { isArrayOf, isShape, isString, nullable, optional } from "@supatype/shared"
import { error, info, plain, warn } from "../ui/messages.js"
import {
  applyRemedies,
  needsOperatorPassword,
  operatorRemedies,
  runPreflight,
  transactionalRemedies,
  type CheckResult,
  type PreflightOptions,
  type PreflightReport,
  type Severity,
} from "../db-preflight.js"

export function registerDb(program: Command): void {
  const db = program
    .command("db")
    .description("Database connection management")

  db
    .command("connection-string")
    .description("Show the database connection string for the linked project")
    .option("--transaction", "Show the transaction pool URL (for serverless/edge functions)")
    .option("--env <name>", "Environment name", "production")
    .action(async (opts: { transaction?: boolean; env?: string }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const link = loadProjectLink(cwd)
      const localConn = resolveHostDatabaseUrl(cwd, config, { allowDerived: true }).dsn

      if (!link || link.kind !== "cloud") {
        const connStr = opts.transaction ? localConn.replace(/:5432\//, ":6432/") : localConn
        plain(connStr)
        plain()
        plain("Session mode (port 5432): for interactive tools (psql, DataGrip, TablePlus)")
        plain("Transaction mode (port 6432): for application servers and serverless functions")
        return
      }

      const target = resolveTarget(cwd, { env: opts.env })
      const envName = opts.env || "production"

      try {
        const data = await targetFetch(
          target.apiBaseUrl,
          target.apiPrefix,
          {
            method: "GET",
            path: `/projects/${target.projectRef}/environments`,
            token: target.token!,
            orgId: target.orgId,
          },
          isArrayOf(isShape({ name: isString, databaseUrl: optional(nullable(isString)) })),
        )

        const env = data.find((e) => e.name === envName)
        if (!env) {
          error(`Environment "${envName}" not found`)
          process.exitCode = 1
          return
        }

        const connStr = env.databaseUrl || "Connection string not available"
        plain(opts.transaction ? connStr.replace(/:5432\//, ":6432/") : connStr)
        plain()
        plain("Session mode (port 5432): for interactive tools (psql, DataGrip, TablePlus)")
        plain("Transaction mode (port 6432): for application servers and serverless functions")
      } catch (err) {
        error(`Failed to fetch connection string: ${errorMessage(err)}`)
        process.exitCode = 1
      }
    })

  db
    .command("reset-password")
    .description("Reset the database password for the linked project")
    .option("--env <name>", "Environment name", "production")
    .action(async (opts: { env?: string }) => {
      const cwd = process.cwd()
      const link = loadProjectLink(cwd)

      if (!link || link.kind !== "cloud") {
        error("Not linked to a cloud project. Run: supatype link --project <ref>")
        process.exitCode = 1
        return
      }

      const target = resolveTarget(cwd, { env: opts.env })
      const envName = opts.env || "production"

      try {
        const data = await targetFetch(
          target.apiBaseUrl,
          target.apiPrefix,
          {
            method: "POST",
            path: `/projects/${target.projectRef}/environments/${envName}/reset-db-password`,
            token: target.token!,
            orgId: target.orgId,
          },
          isShape({ password: optional(nullable(isString)), databaseUrl: optional(nullable(isString)) }),
        )

        info("Database password reset successfully.")
        if (data.databaseUrl) {
          plain(`\nNew connection string:\n${data.databaseUrl}`)
        } else if (data.password) {
          plain(`\nNew password: ${data.password}`)
        }
      } catch (err) {
        error(`Failed to reset password: ${errorMessage(err)}`)
        process.exitCode = 1
      }
    })

  db
    .command("check")
    .description("Check whether a database meets Supatype's requirements (for external Postgres)")
    .option(
      "--connection <url>",
      "Postgres URL to check (else config `connection`, else DATABASE_URL from the environment or .env)",
    )
    .option("--schema <name>", "Schema Supatype will manage (else config `schema.pg_schema`)")
    .option("--emit", "Print the remediation SQL instead of applying it")
    .option("--fix", "Apply the remediation in a single transaction")
    .option(
      "--authenticator-password <password>",
      "Password for the `authenticator` role when it has to be created",
    )
    .action(async (opts: DbCheckOptions) => {
      if (opts.emit && opts.fix) {
        error("Pass either --emit or --fix, not both: one prints the SQL, the other runs it.")
        process.exitCode = 1
        return
      }

      let target: CheckTarget
      try {
        target = checkTarget(process.cwd(), opts)
      } catch (err) {
        rethrowIfConfigBroken(err)
        error(errorMessage(err))
        process.exitCode = 1
        return
      }

      try {
        await withDatabase(target.url, (client) => checkDatabase(client, opts, target.schema), target.source)
      } catch (err) {
        // A failure must not read as a clean bill of health.
        error(err instanceof DatabaseConnectFailed ? `${err.message}.` : `Preflight could not complete: ${errorMessage(err)}`)
        process.exitCode = 1
      }
    })
}

/** The database `db check` connects to, where its URL came from, and the schema it checks. */
interface CheckTarget {
  url: string
  source: string
  schema: string
}

/**
 * What `db check` checks. It is for a Postgres the project does not run, so a stopped local stack is
 * no reason to refuse (issue 49): in a project the URL comes from the resolver every host-side
 * command uses, `.env` included. Outside a project, which is the point (an operator checks a
 * database before writing any config), `--connection` or DATABASE_URL.
 */
function checkTarget(cwd: string, opts: DbCheckOptions): CheckTarget {
  const connection = opts.connection?.trim() || undefined
  const named = opts.schema?.trim() || undefined
  // Both given: nothing to read from a project, so a config that will not load does not matter.
  const config = connection !== undefined && named !== undefined ? undefined : projectConfigIfAny(cwd)
  const schema = named ?? config?.schema?.pg_schema ?? "public"
  if (config !== undefined) {
    const resolved = projectDatabaseUrl(cwd, config, connection)
    return { url: resolved.dsn, source: resolved.source, schema }
  }
  const url = connection ?? (process.env["DATABASE_URL"]?.trim() || undefined)
  if (url === undefined) throw new Error("No connection. Pass --connection or set DATABASE_URL.")
  return { url, source: connection !== undefined ? "--connection" : "DATABASE_URL in the environment", schema }
}

/**
 * The project's database URL. One derived from a Docker project's own stack needs the stack running;
 * with it stopped, every source that was tried is named instead of the local-stack refusal.
 */
function projectDatabaseUrl(cwd: string, config: SupatypeProjectConfig, connection: string | undefined): ResolvedDsn {
  try {
    return resolveHostDatabaseUrl(cwd, config, { connection, allowDerived: true })
  } catch (err) {
    if (!(err instanceof NoStackRunning)) throw err
    return resolveHostDatabaseUrl(cwd, config, { connection, allowDerived: false })
  }
}

/** What `db check` was asked for. */
interface DbCheckOptions {
  connection?: string
  schema?: string
  emit?: boolean
  fix?: boolean
  authenticatorPassword?: string
}

/** `db check` on a connected database: the report, then the SQL, the fix, or what to run next. */
async function checkDatabase(client: Client, opts: DbCheckOptions, schema: string): Promise<void> {
  const report = await runPreflight(client, preflightOptions(opts, schema))
  const fixable = transactionalRemedies(report)
  const manual = operatorRemedies(report)
  if (opts.emit) {
    emitRemedies(fixable, manual)
    return
  }
  printReport(report.results)
  if (opts.fix) {
    if (await fixRemedies(client, preflightOptions(opts, schema), fixable)) warnManualRemedies(manual)
    return
  }
  reportNextStep(report, fixable)
}

/** What the preflight is told: the schema, and the password to give `authenticator` if one was. */
function preflightOptions(opts: DbCheckOptions, schema: string): PreflightOptions {
  return {
    schema,
    ...(opts.authenticatorPassword !== undefined && { authenticatorPassword: opts.authenticatorPassword }),
  }
}

/** `--emit`: SQL on stdout, commentary on stderr, so it can be piped to psql. */
function emitRemedies(fixable: readonly CheckResult[], manual: readonly CheckResult[]): void {
  if (fixable.length === 0) {
    warn("Nothing to emit: no SQL-fixable findings.")
  } else {
    plain("BEGIN;")
    for (const r of fixable) plain(`\n-- ${r.title}\n${r.remedy}`)
    plain("\nCOMMIT;")
  }
  if (manual.length > 0) {
    warn(`\n${manual.length} finding(s) need operator action and are not included above:`)
    for (const r of manual) warn(`  ${r.title}, ${r.detail}`)
  }
}

/**
 * `--fix`: apply what a transaction can, then check again. False when it stopped before applying
 * anything (no password for `authenticator`, or a rollback), which says nothing more.
 */
async function fixRemedies(client: Client, preflight: PreflightOptions, fixable: readonly CheckResult[]): Promise<boolean> {
  if (fixable.length === 0) {
    info("Nothing to fix.")
    return true
  }
  if (needsOperatorPassword(fixable)) {
    // The credential is the operator's by decision. Creating the role with a placeholder
    // password would be worse than refusing, and harder to notice.
    error(
      "`authenticator` has to be created and no password was given. Nothing was changed.\n" +
        "  Re-run with --authenticator-password <password>, or use --emit and apply the SQL yourself.\n" +
        "  Use the same value for AUTHENTICATOR_PASSWORD in your .env.",
    )
    process.exitCode = 1
    return false
  }
  info(`\nApplying ${fixable.length} remediation(s) in one transaction...`)
  try {
    await applyRemedies(client, fixable)
  } catch (err) {
    error(`Rolled back: the database is unchanged: ${errorMessage(err)}`)
    process.exitCode = 1
    return false
  }
  await confirmApplied(client, preflight, fixable.length)
  return true
}

/**
 * Re-read rather than report the commit. A committed statement is not a fixed finding: `GRANT` on
 * an object the caller does not own raises `WARNING: no privileges were granted` and commits
 * happily, so "Applied" was a claim about the transaction rather than about the database. Checking
 * is the whole job of this command.
 */
async function confirmApplied(client: Client, preflight: PreflightOptions, applied: number): Promise<void> {
  const stillFailing = transactionalRemedies(await runPreflight(client, preflight))
  if (stillFailing.length === 0) {
    info(`Applied. ${applied} finding(s) fixed and confirmed.`)
    return
  }
  error(`\nApplied, but ${stillFailing.length} of ${applied} finding(s) are still failing:`)
  for (const r of stillFailing) error(`  ${r.title}: ${r.detail}`)
  error(
    "\n  The statements committed without error and changed nothing that the check can see.\n" +
      "  The usual cause is a privilege the connected role does not hold: Postgres reports\n" +
      "  that as a warning, not an error. Re-run with --emit and apply the SQL as an owner.",
  )
  process.exitCode = 1
}

/** The findings `--fix` cannot apply in a transaction. */
function warnManualRemedies(manual: readonly CheckResult[]): void {
  if (manual.length === 0) return
  warn(`\n${manual.length} finding(s) cannot be fixed in a transaction:`)
  for (const r of manual) warn(`  ${r.title}: needs a server setting change and likely a restart`)
}

/** Without `--emit` or `--fix`: whether the database is ready, and what to run if it is not. */
function reportNextStep(report: PreflightReport, fixable: readonly CheckResult[]): void {
  if (report.worst === "fail") {
    plain("")
    error("This database is not ready. Re-run with --emit to see the SQL, or --fix to apply it.")
    process.exitCode = 1
  } else if (fixable.length > 0) {
    plain("")
    info("Re-run with --emit to see suggested SQL, or --fix to apply it.")
  }
}

const SEVERITY_LABEL: Record<Severity, string> = {
  pass: "ok  ",
  warn: "note",
  degrade: "off ",
  fail: "FAIL",
}

function printReport(results: readonly CheckResult[]): void {
  for (const r of results) {
    const line = `[${SEVERITY_LABEL[r.severity]}] ${r.title}, ${r.detail}`
    if (r.severity === "fail") error(line)
    else if (r.severity === "degrade" || r.severity === "warn") warn(line)
    else plain(line)
    if (r.impact) plain(`         ${r.impact}`)
  }
}
