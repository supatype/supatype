import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { pgSchema, schemaPathFromProject } from "../project-config.js"
import { schemaCommandTarget, targetSchemaAdopt } from "../resolve-target.js"
import {
  adoptedCount,
  adoptionLines,
  isStalePreview,
  previewedKeys,
  STALE_PREVIEW_MESSAGE,
} from "../adopt-walkthrough.js"
import type { AdoptOutcome } from "../engine-client.js"
import { askConsent } from "../ui/confirm.js"
import { error, info, plain } from "../ui/messages.js"
import { requireEngineForOwnershipFlag } from "../engine-ownership-gate.js"
import { withSpinner } from "../ui/progress.js"
import { addRetiredNoCacheOption, warnIfRetiredNoCache } from "../retired-no-cache.js"

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
  const run = (yes: boolean, keys?: string[]): Promise<AdoptOutcome> =>
    targetSchemaAdopt(target, ast, {
      schema: pgSchema(config),
      yes,
      ...(opts.release !== undefined && { release: opts.release }),
      ...(keys !== undefined && { keys }),
    })
  // `--yes` already agreed, so one engine call does it and its outcome says what it took. No
  // preview was shown, so it names no keys: it adopts the conflicts found as it runs.
  if (opts.yes) {
    const outcome = await run(true)
    for (const line of previewLines(outcome)) plain(`  ${line}`)
    report(outcome)
    return
  }
  const preview = await run(false)
  if (!show(previewLines(preview))) return
  // What was just shown is what is agreed to: applying names those conflicts, and the engine writes
  // nothing if the database has changed since. An engine from before the ledger names none.
  const keys = previewedKeys(preview)
  if (keys !== undefined) await requireEngineForOwnershipFlag("adopt", config)
  const consent = await askConsent("Go ahead?", false)
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
  let outcome: AdoptOutcome
  try {
    outcome = await run(true, keys)
  } catch (err: unknown) {
    if (!isStalePreview(err)) throw err
    error(STALE_PREVIEW_MESSAGE)
    process.exitCode = 1
    return
  }
  report(outcome)
}

/** Prints what adopt will do, or says there is nothing; whether there was anything. */
function show(lines: readonly string[]): boolean {
  if (lines.length === 0) {
    info("Nothing to adopt: every object the schema declares is Supatype's or absent.")
    return false
  }
  plain(`\nAdopt will:\n`)
  for (const line of lines) plain(`  ${line}`)
  return true
}

function report(outcome: AdoptOutcome): void {
  info(`Adopted ${adoptedCount(outcome)} object(s), released ${outcome.release?.length ?? 0}.`)
}
