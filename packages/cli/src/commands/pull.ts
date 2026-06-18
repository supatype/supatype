import type { Command } from "commander"
import { writeFileSync } from "node:fs"
import { loadConfig } from "../config.js"
import { schemaPathFromProject } from "../project-config.js"
import { ensureEngine, engineRequest } from "../engine-client.js"
import { resolveHostEngineDatabaseUrl } from "../dev-compose.js"
import { databaseStateToSchemaScaffold, type DatabaseStateJson } from "../pull-utils.js"

export function registerPull(program: Command): void {
  program
    .command("pull")
    .description("Scaffold schema/index.ts from live database introspection (draft — review before push)")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option("--out <path>", "Write scaffold to file (default: stdout)")
    .option("--dry-run", "Print scaffold to stdout without writing files")
    .action(async (opts: { connection?: string; out?: string; dryRun?: boolean }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const connection = await resolveHostEngineDatabaseUrl(cwd, config, opts.connection)
      const pgSchema = config.schema?.pg_schema ?? "public"

      await ensureEngine()

      console.error("Introspecting database...")
      const state = await engineRequest<DatabaseStateJson>("/introspect", {
        database_url: connection,
        schema: pgSchema,
      })

      const scaffold = databaseStateToSchemaScaffold(state)
      const defaultOut = schemaPathFromProject(config, cwd)

      if (opts.dryRun || !opts.out) {
        console.log(scaffold)
        if (!opts.dryRun && !opts.out) {
          console.error("\n(draft printed to stdout — use --out to write a file)")
        }
        return
      }

      writeFileSync(opts.out ?? defaultOut, scaffold, "utf8")
      console.log(`Wrote draft schema to ${opts.out ?? defaultOut}`)
      console.log("Review access rules and relations, then run `supatype generate`.")
    })
}
