/**
 * Database connection commands:
 *   supatype db connection-string  — show the connection string for the linked project
 *   supatype db reset-password     — reset the database password
 */

import type { Command } from "commander"
import { loadConfig } from "../config.js"
import { connectionString } from "../project-config.js"
import { loadCloudConfig } from "./cloud.js"

export function registerDb(program: Command): void {
  const db = program
    .command("db")
    .description("Database connection management")

  // supatype db connection-string
  db
    .command("connection-string")
    .description("Show the database connection string for the linked project")
    .option("--transaction", "Show the transaction pool URL (for serverless/edge functions)")
    .option("--env <name>", "Environment name", "production")
    .action(async (opts: { transaction?: boolean; env?: string }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const cloudCfg = loadCloudConfig(cwd)
      const localConn = connectionString(config)

      // If no cloud project linked, show the local connection string.
      if (!cloudCfg?.projectSlug) {
        const connStr = opts.transaction ? localConn.replace(/:5432\//, ":6432/") : localConn
        console.log(connStr)
        console.log()
        console.log("Session mode (port 5432): for interactive tools (psql, DataGrip, TablePlus)")
        console.log("Transaction mode (port 6432): for application servers and serverless functions")
        return
      }

      // If linked to a cloud project, fetch from the API
      const apiUrl = cloudCfg.apiUrl || "https://api.supatype.io"
      const token = cloudCfg.token || process.env["SUPATYPE_ACCESS_TOKEN"] || ""
      const envName = opts.env || "production"

      try {
        const res = await fetch(
          `${apiUrl}/platform/v1/projects/${cloudCfg.projectSlug}/environments`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        )

        if (!res.ok) {
          console.error(`Failed to fetch project info: ${res.status}`)
          process.exitCode = 1
          return
        }

        const { data } = (await res.json()) as { data: Array<{ name: string; databaseUrl?: string }> }
        const env = data.find((e) => e.name === envName)

        if (!env) {
          console.error(`Environment "${envName}" not found`)
          process.exitCode = 1
          return
        }

        const connStr = env.databaseUrl || "Connection string not available"
        if (opts.transaction) {
          console.log(connStr.replace(/:5432\//, ":6432/"))
        } else {
          console.log(connStr)
        }

        console.log()
        console.log("Session mode (port 5432): for interactive tools (psql, DataGrip, TablePlus)")
        console.log("Transaction mode (port 6432): for application servers and serverless functions")
      } catch (err) {
        console.error("Failed to fetch connection string:", (err as Error).message)
        process.exitCode = 1
      }
    })

  // supatype db reset-password
  db
    .command("reset-password")
    .description("Reset the database password for the linked project")
    .option("--env <name>", "Environment name", "production")
    .action(async (opts: { env?: string }) => {
      const cwd = process.cwd()
      const cloudCfg = loadCloudConfig(cwd)

      if (!cloudCfg?.projectSlug) {
        console.error("Not linked to a cloud project. Run: supatype link --project <ref>")
        process.exitCode = 1
        return
      }

      const apiUrl = cloudCfg.apiUrl || "https://api.supatype.io"
      const token = cloudCfg.token || process.env["SUPATYPE_ACCESS_TOKEN"] || ""
      const envName = opts.env || "production"

      try {
        const res = await fetch(
          `${apiUrl}/platform/v1/projects/${cloudCfg.projectSlug}/environments/${envName}/reset-db-password`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          },
        )

        if (!res.ok) {
          const body = await res.text()
          console.error(`Failed to reset password: ${res.status} ${body}`)
          process.exitCode = 1
          return
        }

        const { data } = (await res.json()) as { data: { password: string; connectionString: string } }
        console.log("Database password reset successfully.")
        console.log()
        console.log(`New password: ${data.password}`)
        console.log(`Connection string: ${data.connectionString}`)
        console.log()
        console.log("Warning: Existing database connections have been terminated.")
        console.log("Update your application with the new connection string.")
      } catch (err) {
        console.error("Failed to reset password:", (err as Error).message)
        process.exitCode = 1
      }
    })
}
