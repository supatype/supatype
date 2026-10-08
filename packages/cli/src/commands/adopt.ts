import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { schemaPathFromProject } from "../project-config.js"
import { targetSchemaAdopt, schemaPgSchema } from "../resolve-target.js"
import { adoptedCount, adoptionLines, type AdoptOutcome } from "../adopt-walkthrough.js"
import { askConsent } from "../ui/confirm.js"
import { error, info, plain } from "../ui/messages.js"
import { requireEngineForOwnershipFlag } from "../engine-ownership-gate.js"
import { withSpinner } from "../ui/progress.js"
import { addRetiredNoCacheOption, warnIfRetiredNoCache } from "../retired-no-cache.js"
import { schemaCommandTarget } from "./doctor.js"

interface AdoptOptions {
  connection?: string
  env?: string
  direct?: boolean
  yes?: boolean
  cache?: boolean
  release?: string[]
}

/** What a preview says adopt will do, one line per object: handed over, then taken back. */
export function previewLines(outcome: AdoptOutcome): string[] {
  return [...adoptionLines(outcome), ...(outcome.release ?? []).map((item) => item.message)]
}

export function registerAdopt(program: Command): void {
  const command = program
    .command("adopt")
    .description(
      "Hand Supatype the objects a push refuses because their names are taken, or take objects back with --release",
    )
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option("--env <name>", "Target environment when linked")
    .option("--direct", "Use local engine subprocess")
    .option(
      "--release <object...>",
      "Leave an object alone on every push, named as doctor names it: kind:table.name, or kind:name for a table",
    )
    .option("--yes", "Adopt without asking")
  addRetiredNoCacheOption(command).action(adopt)
}

async function adopt(opts: AdoptOptions): Promise<void> {
  warnIfRetiredNoCache(opts)
  const cwd = process.cwd()
  const config = loadConfig(cwd)
  if (opts.release !== undefined) await requireEngineForOwnershipFlag("--release", config)
  const ast = await withSpinner("Loading schema", async () =>
    loadSchemaAst(schemaPathFromProject(config, cwd), cwd),
  )
  const target = await schemaCommandTarget(cwd, config, opts)
  const run = (yes: boolean): Promise<AdoptOutcome> =>
    targetSchemaAdopt(target, ast, {
      schema: schemaPgSchema(cwd),
      yes,
      ...(opts.release !== undefined && { release: opts.release }),
    })

  const lines = previewLines(await run(false))
  if (lines.length === 0) {
    info("Nothing to adopt: every object the schema declares is Supatype's or absent.")
    return
  }
  plain(`\nAdopt will:\n`)
  for (const line of lines) plain(`  ${line}`)
  const consent = await askConsent("Go ahead?", opts.yes ?? false)
  if (consent === "needs-yes") {
    // Not a decline: a pipeline that forgot --yes adopted nothing, and must not pass as if it had.
    error("adopt needs --yes when not interactive")
    process.exitCode = 1
    return
  }
  if (consent === "declined") {
    plain("Adoption cancelled.")
    return
  }
  const outcome = await run(true)
  info(`Adopted ${adoptedCount(outcome)} object(s), released ${outcome.release?.length ?? 0}.`)
}
