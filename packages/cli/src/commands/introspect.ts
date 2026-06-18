import type { Command } from "commander"
import { writeFileSync } from "node:fs"
import { loadConfig } from "../config.js"
import { ensureEngine, engineRequest } from "../engine-client.js"
import { resolveHostEngineDatabaseUrl } from "../dev-compose.js"
import type { DatabaseStateJson } from "../pull-utils.js"
import { printIntrospectSummary } from "../pull-utils.js"

export function registerIntrospect(program: Command): void {
  program
    .command("introspect")
    .description("Introspect the live Postgres database (JSON or summary)")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option("--json", "Output full DatabaseState JSON")
    .option("--out <path>", "Write JSON output to a file")
    .action(async (opts: { connection?: string; json?: boolean; out?: string }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const connection = await resolveHostEngineDatabaseUrl(cwd, config, opts.connection)
      const pgSchema = config.schema?.pg_schema ?? "public"

      await ensureEngine()

      const state = await engineRequest<DatabaseStateJson>("/introspect", {
        database_url: connection,
        schema: pgSchema,
      })

      if (opts.out) {
        writeFileSync(opts.out, JSON.stringify(state, null, 2), "utf8")
        console.log(`Wrote introspection to ${opts.out}`)
        return
      }

      if (opts.json) {
        console.log(JSON.stringify(state, null, 2))
        return
      }

      printIntrospectSummary(state)
    })
}
