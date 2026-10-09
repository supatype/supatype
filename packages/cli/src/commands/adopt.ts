import { resolve } from "node:path"
import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { pgSchema, schemaPathFromProject } from "../project-config.js"
import { schemaCommandTarget, targetSchemaAdopt, targetSchemaIntrospect } from "../resolve-target.js"
import {
  adoptedCount,
  adoptionKey,
  adoptionLines,
  isStalePreview,
  previewedKeys,
  STALE_PREVIEW_MESSAGE,
} from "../adopt-walkthrough.js"
import type { AdoptOutcome } from "../engine-client.js"
import { declareAdoptedColumns } from "../adopt-columns.js"
import { askConsent, confirm } from "../ui/confirm.js"
import { isInteractive } from "../ui/interactive.js"
import { error, info, plain, warn } from "../ui/messages.js"
import { requireEngineForOwnershipFlag } from "../engine-ownership-gate.js"
import { withSpinner } from "../ui/progress.js"
import { addRetiredNoCacheOption, warnIfRetiredNoCache } from "../retired-no-cache.js"
import { regenerateTypes } from "./generate.js"

interface AdoptOptions {
  connection?: string
  env?: string
  direct?: boolean
  yes?: boolean
  cache?: boolean
  release?: string[]
  reclaim?: string[]
  key?: string[]
}

/** What a preview says adopt will do, one line per object: handed over, taken back, handed back. */
export function previewLines(outcome: AdoptOutcome): string[] {
  const named = [...(outcome.release ?? []), ...(outcome.reclaim ?? [])]
  return [...adoptionLines(outcome), ...named.map((item) => item.message)]
}

export function registerAdopt(program: Command): void {
  const command = program
    .command("adopt")
    .description(
      "Hand Supatype the objects a push refuses because their names are taken; take objects back with --release, and hand them back with --reclaim",
    )
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option("--env <name>", "Target environment when linked")
    .option("--direct", "Use local engine subprocess")
    .option(
      "--release <object...>",
      "Leave an object alone on every push, named as doctor names it: kind:table.name, or kind:name for a table",
    )
    .option(
      "--reclaim <object...>",
      "Hand a released object back to Supatype, named the same way: the next push makes it match the schema",
    )
    .option(
      "--key <object...>",
      "Adopt only these conflicts, named as doctor names them (kind:table.name, or kind:name for a table); " +
        "if one is no longer a conflict nothing is written",
    )
    .option("--yes", "Adopt without asking")
  addRetiredNoCacheOption(command).action(adopt)
}

async function adopt(opts: AdoptOptions): Promise<void> {
  warnIfRetiredNoCache(opts)
  const cwd = process.cwd()
  const config = loadConfig(cwd)
  if (opts.release !== undefined) await requireEngineForOwnershipFlag("--release", config)
  if (opts.reclaim !== undefined) await requireEngineForOwnershipFlag("--reclaim", config)
  if (opts.key !== undefined) await requireEngineForOwnershipFlag("--key", config)
  const ast = await withSpinner("Loading schema", async () =>
    loadSchemaAst(schemaPathFromProject(config, cwd), cwd),
  )
  const target = await schemaCommandTarget(cwd, config, opts)
  const run = (yes: boolean, keys?: string[]): Promise<AdoptOutcome> =>
    targetSchemaAdopt(target, ast, {
      schema: pgSchema(config),
      yes,
      ...(opts.release !== undefined && { release: opts.release }),
      ...(opts.reclaim !== undefined && { reclaim: opts.reclaim }),
      ...(keys !== undefined && { keys }),
    })
  // An adopted column is managed, so the schema declares it from now on (see adopt-columns.ts).
  const declare = (outcome: AdoptOutcome) =>
    declareAdoptedColumns(
      outcome.adopt ?? [],
      {
        entryPath: resolve(cwd, schemaPathFromProject(config, cwd)),
        cwd,
        yes: opts.yes ?? false,
        interactive: isInteractive(),
      },
      {
        introspect: () => targetSchemaIntrospect(target, { schema: pgSchema(config) }),
        confirm: async (question) => (await confirm(question, { default: false })) === true,
        regenerate: () => regenerateTypes(cwd),
        say: { info, warn, plain },
      },
    )
  // `--yes` already agreed, so one engine call does it and its outcome says what it took: with
  // `--key` only those objects, and without, every conflict found as it runs.
  if (opts.yes) {
    const outcome = await applying(() => run(true, opts.key))
    if (outcome === undefined) return
    for (const line of previewLines(outcome)) plain(`  ${line}`)
    report(outcome)
    await declare(outcome)
    return
  }
  const preview = keyedOnly(await run(false), opts.key)
  if (!show(previewLines(preview), opts.key !== undefined)) return
  // `--key` names what to adopt. Otherwise what was just shown is what is agreed to: applying names
  // those conflicts, and the engine writes nothing if the database has changed since. An engine
  // from before the ledger names none.
  const keys = opts.key ?? previewedKeys(preview)
  if (opts.key === undefined && keys !== undefined) await requireEngineForOwnershipFlag("adopt", config)
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
  const outcome = await applying(() => run(true, keys))
  if (outcome === undefined) return
  report(outcome)
  await declare(outcome)
}

/**
 * The outcome of applying, or undefined, having said so and set exit 1, when the engine refused
 * because an object it was to adopt is no longer a conflict.
 */
async function applying(apply: () => Promise<AdoptOutcome>): Promise<AdoptOutcome | undefined> {
  try {
    return await apply()
  } catch (err: unknown) {
    if (!isStalePreview(err)) throw err
    error(STALE_PREVIEW_MESSAGE)
    process.exitCode = 1
    return undefined
  }
}

/**
 * Prints what adopt will do, or says there is nothing; whether to go on. With `--key` it goes on
 * regardless: the engine says if a named object is not a conflict.
 */
function show(lines: readonly string[], keyed: boolean): boolean {
  if (lines.length === 0 && !keyed) {
    info("Nothing to adopt: every object the schema declares is Supatype's or absent.")
    return false
  }
  plain(`\nAdopt will:\n`)
  for (const line of lines) plain(`  ${line}`)
  return true
}

function report(outcome: AdoptOutcome): void {
  info(
    `Adopted ${adoptedCount(outcome)} object(s), released ${outcome.release?.length ?? 0}, ` +
      `reclaimed ${outcome.reclaim?.length ?? 0}.`,
  )
}

/** The preview with only the conflicts `keys` names, when it names any. */
export function keyedOnly(outcome: AdoptOutcome, keys: readonly string[] | undefined): AdoptOutcome {
  if (keys === undefined || outcome.adopt === undefined) return outcome
  return { ...outcome, adopt: outcome.adopt.filter((item) => keys.includes(adoptionKey(item))) }
}
