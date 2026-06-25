/**
 * Database connection commands:
 *   supatype db connection-string  — show the connection string for the linked project
 *   supatype db reset-password     — reset the database password
 */

import type { Command } from "commander"
import { loadConfig } from "../config.js"
import { connectionString } from "../project-config.js"
import { loadProjectLink } from "../link.js"
import { resolveTarget } from "../resolve-target.js"
import { targetFetch } from "../target-client.js"
import { error, info, plain } from "../ui/messages.js"

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
}
