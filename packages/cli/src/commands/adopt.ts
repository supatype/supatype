import { resolve } from "node:path"
import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { schemaPathFromProject } from "../project-config.js"
import { requireTargetFeatures, targetSchemaAdopt, targetSchemaIntrospect, schemaPgSchema } from "../resolve-target.js"
import {
  adoptedCount,
  adoptionKey,
  adoptionLines,
  ENGINE_BUSY_MESSAGE,
  isEngineBusy,
  isStalePreview,
  previewedKeys,
  STALE_PREVIEW_MESSAGE,
  type AdoptOutcome,
} from "../adopt-walkthrough.js"
import { declareAdoptedColumns, previewKeyedColumns } from "../adopt-columns.js"
import { askConsent, confirm } from "../ui/confirm.js"
import { isInteractive } from "../ui/interactive.js"
import { error, info, plain, warn } from "../ui/messages.js"
import { adoptKeysNeed, adoptNeeds } from "../engine-ownership-gate.js"
import { withSpinner } from "../ui/progress.js"
import { addRetiredNoCacheOption, warnIfRetiredNoCache } from "../retired-no-cache.js"
import { schemaCommandTarget } from "./doctor.js"
import { regenerateTypes } from "./generate.js"

interface AdoptOptions {
  connection?: string
  env?: string
  direct?: boolean
  yes?: boolean
  cache?: boolean
  release?: string[]
  key?: string[]
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
  const ast = await withSpinner("Loading schema", async () =>
    loadSchemaAst(schemaPathFromProject(config, cwd), cwd),
  )
  const target = await schemaCommandTarget(cwd, config, opts)
  // Before the preview: the server or engine that adopts must take every flag given.
  await requireTargetFeatures(target, adoptNeeds({ release: opts.release, keys: opts.key }))
  const run = (yes: boolean, keys?: string[]): Promise<AdoptOutcome> =>
    targetSchemaAdopt(target, ast, {
      schema: schemaPgSchema(cwd),
      yes,
      ...(opts.release !== undefined && { release: opts.release }),
      ...(keys !== undefined && { keys }),
    })

  const entryPath = resolve(cwd, schemaPathFromProject(config, cwd))
  const introspect = (): Promise<unknown> => targetSchemaIntrospect(target, { schema: schemaPgSchema(cwd) })

  const preview = keyedOnly(await run(false), opts.key)
  // A column added outside Supatype is not a conflict, so the engine's preview does not list it:
  // say here what adopting each keyed one does, including the field the schema will gain.
  const columnLines =
    opts.key === undefined
      ? []
      : await previewKeyedColumns(opts.key, previewedKeys(preview) ?? [], { entryPath, cwd }, { introspect })
  const lines = [...previewLines(preview), ...columnLines]
  if (lines.length === 0 && opts.key === undefined) {
    info("Nothing to adopt: every object the schema declares is Supatype's or absent.")
    return
  }
  plain(`\nAdopt will:\n`)
  for (const line of lines) plain(`  ${line}`)
  // `--key` names what to adopt. Otherwise, agreeing at the prompt agrees to what was just shown:
  // applying names those conflicts, and the engine writes nothing if the database has changed
  // since. `--yes` alone was agreed before anything was shown, so it adopts every conflict there
  // is. An engine from before the ledger names none.
  const keys = opts.key ?? (opts.yes ? undefined : previewedKeys(preview))
  // Before anyone is asked: applying sends what was shown, which the target must honour.
  if (opts.key === undefined && keys !== undefined) await requireTargetFeatures(target, [adoptKeysNeed(keys)])
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
  let outcome: AdoptOutcome
  try {
    outcome = await run(true, keys)
  } catch (err: unknown) {
    if (!isStalePreview(err) && !isEngineBusy(err)) throw err
    // Nothing was written either way: the engine refused before it took anything.
    error(isEngineBusy(err) ? ENGINE_BUSY_MESSAGE : STALE_PREVIEW_MESSAGE)
    process.exitCode = 1
    return
  }
  if (keys === undefined) {
    // Agreed before it ran, so what it found may not be what was shown: say what it took.
    for (const line of adoptionLines(outcome)) plain(`  ${line}`)
  }
  info(`Adopted ${adoptedCount(outcome)} object(s), released ${outcome.release?.length ?? 0}.`)
  // An adopted column is managed, so the schema declares it from now on (see adopt-columns.ts).
  await declareAdoptedColumns(
    outcome.adopt ?? [],
    {
      entryPath,
      cwd,
      yes: opts.yes ?? false,
      interactive: isInteractive(),
    },
    {
      introspect,
      confirm: async (question) => (await confirm(question, { default: false })) === true,
      regenerate: () => regenerateTypes(cwd),
      say: { info, warn, plain },
    },
  )
}

/** The preview with only the conflicts `keys` names, when it names any. */
export function keyedOnly(outcome: AdoptOutcome, keys: readonly string[] | undefined): AdoptOutcome {
  if (keys === undefined || outcome.adopt === undefined) return outcome
  return { ...outcome, adopt: outcome.adopt.filter((item) => keys.includes(adoptionKey(item))) }
}
