/**
 * Database connection commands:
 *   supatype db connection-string  — show the connection string for the linked project
 *   supatype db reset-password     — reset the database password
 *   supatype db check              — does this database meet what Supatype needs of it?
 */

import type { Command } from "commander"
import { loadConfig } from "../config.js"
import { connectionString } from "../project-config.js"
import { loadProjectLink } from "../link.js"
import { resolveTarget } from "../resolve-target.js"
import { targetFetch } from "../target-client.js"
import { error, info, plain, warn } from "../ui/messages.js"
import {
  applyRemedies,
  needsOperatorPassword,
  operatorRemedies,
  runPreflight,
  transactionalRemedies,
  type CheckResult,
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
      const localConn = connectionString(config)

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
        const data = await targetFetch<Array<{ name: string; databaseUrl?: string }>>(
          target.apiBaseUrl,
          target.apiPrefix,
          {
            method: "GET",
            path: `/projects/${target.projectRef}/environments`,
            token: target.token!,
            orgId: target.orgId,
          },
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
        error(`Failed to fetch connection string: ${(err as Error).message}`)
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
        const data = await targetFetch<{ password?: string; databaseUrl?: string }>(
          target.apiBaseUrl,
          target.apiPrefix,
          {
            method: "POST",
            path: `/projects/${target.projectRef}/environments/${envName}/reset-db-password`,
            token: target.token!,
            orgId: target.orgId,
          },
        )

        info("Database password reset successfully.")
        if (data.databaseUrl) {
          plain(`\nNew connection string:\n${data.databaseUrl}`)
        } else if (data.password) {
          plain(`\nNew password: ${data.password}`)
        }
      } catch (err) {
        error(`Failed to reset password: ${(err as Error).message}`)
        process.exitCode = 1
      }
    })

  db
    .command("check")
    .description("Check whether a database meets Supatype's requirements (for external Postgres)")
    .option("--connection <url>", "Postgres URL to check (else config `connection`, else DATABASE_URL)")
    .option("--schema <name>", "Schema Supatype will manage (else config `schema.pg_schema`)")
    .option("--emit", "Print the remediation SQL instead of applying it")
    .option("--fix", "Apply the remediation in a single transaction")
    .option(
      "--authenticator-password <password>",
      "Password for the `authenticator` role when it has to be created",
    )
    .action(async (opts: {
      connection?: string
      schema?: string
      emit?: boolean
      fix?: boolean
      authenticatorPassword?: string
    }) => {
      if (opts.emit && opts.fix) {
        error("Pass either --emit or --fix, not both: one prints the SQL, the other runs it.")
        process.exitCode = 1
        return
      }

      const cwd = process.cwd()
      let url = opts.connection?.trim()
      let schema = opts.schema?.trim()
      if (!url || !schema) {
        try {
          const config = loadConfig(cwd)
          url = url ?? connectionString(config)
          schema = schema ?? config.schema?.pg_schema ?? "public"
        } catch {
          // Runnable outside a project, which is the point — an operator should be able to check a
          // database before committing to any config at all.
          url = url ?? process.env["DATABASE_URL"]
          schema = schema ?? "public"
        }
      }
      if (!url) {
        error("No connection. Pass --connection, set DATABASE_URL, or set `connection` in supatype.config.ts.")
        process.exitCode = 1
        return
      }

      const pgMod = await import("pg")
      const client = new pgMod.default.Client({ connectionString: url })
      try {
        await client.connect()
      } catch (err) {
        error(`Could not connect: ${(err as Error).message}`)
        process.exitCode = 1
        return
      }

      try {
        const report = await runPreflight(client, {
          schema: schema!,
          ...(opts.authenticatorPassword !== undefined && {
            authenticatorPassword: opts.authenticatorPassword,
          }),
        })

        const fixable = transactionalRemedies(report)
        const manual = operatorRemedies(report)

        if (opts.emit) {
          // Machine-consumable: SQL on stdout, commentary on stderr, so it can be piped to psql.
          if (fixable.length === 0) {
            warn("Nothing to emit — no SQL-fixable findings.")
          } else {
            plain("BEGIN;")
            for (const r of fixable) plain(`\n-- ${r.title}\n${r.remedy}`)
            plain("\nCOMMIT;")
          }
          if (manual.length > 0) {
            warn(`\n${manual.length} finding(s) need operator action and are not included above:`)
            for (const r of manual) warn(`  ${r.title} — ${r.detail}`)
          }
          return
        }

        printReport(report.results)

        if (opts.fix) {
          if (fixable.length === 0) {
            info("Nothing to fix.")
          } else if (needsOperatorPassword(fixable)) {
            // The credential is the operator's by decision. Creating the role with a placeholder
            // password would be worse than refusing, and harder to notice.
            error(
              "`authenticator` has to be created and no password was given. Nothing was changed.\n" +
                "  Re-run with --authenticator-password <password>, or use --emit and apply the SQL yourself.\n" +
                "  Use the same value for AUTHENTICATOR_PASSWORD in your .env.",
            )
            process.exitCode = 1
            return
          } else {
            info(`\nApplying ${fixable.length} remediation(s) in one transaction...`)
            try {
              await applyRemedies(client, fixable)
              info("Applied. Re-run `supatype db check` to confirm.")
            } catch (err) {
              error(`Rolled back — the database is unchanged: ${(err as Error).message}`)
              process.exitCode = 1
              return
            }
          }
          if (manual.length > 0) {
            warn(`\n${manual.length} finding(s) cannot be fixed in a transaction:`)
            for (const r of manual) {
              warn(`  ${r.title} — needs a server setting change and likely a restart`)
            }
          }
          return
        }

        if (report.worst === "fail") {
          plain("")
          error("This database is not ready. Re-run with --emit to see the SQL, or --fix to apply it.")
          process.exitCode = 1
        } else if (fixable.length > 0) {
          plain("")
          info("Re-run with --emit to see suggested SQL, or --fix to apply it.")
        }
      } catch (err) {
        // An unexpected failure must not read as a clean bill of health.
        error(`Preflight could not complete: ${(err as Error).message}`)
        process.exitCode = 1
      } finally {
        await client.end().catch(() => undefined)
      }
    })
}

const SEVERITY_LABEL: Record<Severity, string> = {
  pass: "ok  ",
  warn: "note",
  degrade: "off ",
  fail: "FAIL",
}

function printReport(results: readonly CheckResult[]): void {
  for (const r of results) {
    const line = `[${SEVERITY_LABEL[r.severity]}] ${r.title} — ${r.detail}`
    if (r.severity === "fail") error(line)
    else if (r.severity === "degrade" || r.severity === "warn") warn(line)
    else plain(line)
    if (r.impact) plain(`         ${r.impact}`)
  }
}
