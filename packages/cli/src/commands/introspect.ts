import type { Command } from "commander"
import { writeFileSync } from "node:fs"
import { loadProjectLink } from "../link.js"
import { resolveTarget, targetSchemaIntrospect, schemaPgSchema } from "../resolve-target.js"
import type { DatabaseStateJson } from "../pull-utils.js"
import { printIntrospectSummary } from "../pull-utils.js"

export function registerIntrospect(program: Command): void {
  program
    .command("introspect")
    .description("Introspect the live Postgres database (JSON or summary)")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option("--env <name>", "Target environment when linked")
    .option("--direct", "Use local engine subprocess")
    .option("--json", "Output full DatabaseState JSON")
    .option("--out <path>", "Write JSON output to a file")
    .action(async (opts: {
      connection?: string
      env?: string
      direct?: boolean
      json?: boolean
      out?: string
    }) => {
      const cwd = process.cwd()
      const pgSchema = schemaPgSchema(cwd)

      const linked = loadProjectLink(cwd)
      const target = linked && !opts.direct && !opts.connection
        ? resolveTarget(cwd, { env: opts.env })
        : resolveTarget(cwd, { env: opts.env, direct: true, connection: opts.connection })

      const state = (await targetSchemaIntrospect(target, { schema: pgSchema })) as DatabaseStateJson

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
