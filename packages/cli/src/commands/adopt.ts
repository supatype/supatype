import { resolve } from "node:path"
import type { Command } from "commander"
import { loadConfig, loadSchemaAst } from "../config.js"
import { withPublishing } from "../model-versioning.js"
import { pgSchema, schemaPathFromProject } from "../project-config.js"
import {
  requireTargetFeatures,
  schemaCommandTarget,
  targetCapabilities,
  targetSchemaAdopt,
  targetSchemaIntrospect,
} from "../resolve-target.js"
import {
  adoptedCount,
  adoptionKey,
  adoptionLines,
  ENGINE_BUSY_MESSAGE,
  isEngineBusy,
  isStalePreview,
  previewedKeys,
  isTableKey,
  STALE_PREVIEW_MESSAGE,
  tableAccessConflicts,
} from "../adopt-walkthrough.js"
import type { AdoptOutcome, DoctorItem } from "../engine-client.js"
import { declareAdoptedColumns, previewKeyedColumns } from "../adopt-columns.js"
import { askConsent, confirm } from "../ui/confirm.js"
import { isInteractive } from "../ui/interactive.js"
import { error, info, plain, warn } from "../ui/messages.js"
import { adoptKeysNeed, adoptNeeds } from "../engine-ownership-gate.js"
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
  adoptNone?: boolean
}

/**
 * The conflicts this run may adopt, as the `keys` the engine takes: `--key`'s, none for
 * `--adopt-none` or for a run that names objects to release or reclaim, and undefined (every
 * conflict) otherwise. `--release X --yes` used to adopt every conflict there was besides (C01).
 */
export function adoptableKeys(opts: Pick<AdoptOptions, "key" | "adoptNone" | "release" | "reclaim">): string[] | undefined {
  if (opts.adoptNone === true && opts.key !== undefined) {
    throw new Error("--adopt-none and --key contradict each other: --key names the conflicts to adopt.")
  }
  if (opts.key !== undefined) return opts.key
  const namesOthers = (opts.release ?? []).length > 0 || (opts.reclaim ?? []).length > 0
  return opts.adoptNone === true || namesOthers ? [] : undefined
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
    .option(
      "--adopt-none",
      "Adopt no conflict; what --release and --reclaim do on their own, unless --key names some",
    )
    .option("--yes", "Adopt without asking")
  addRetiredNoCacheOption(command).action(adopt)
}

/** One `adopt` run: what it may adopt, and how it reaches the target. */
interface AdoptRun {
  /** The keys `--key` (or `--adopt-none`, `--release`, `--reclaim`) settled on; undefined is every conflict. */
  named: string[] | undefined
  run: (yes: boolean, keys?: string[]) => Promise<AdoptOutcome>
  /** Refuse keys a preview chose that the target cannot honour (`--key`'s were checked already). */
  requireKeys: (keys: string[]) => Promise<void>
  /** Declare each adopted column in the schema (see adopt-columns.ts). */
  declare: (outcome: AdoptOutcome) => Promise<void>
  /** What adopting each `--key` column does, including the field the schema will gain. */
  columnLines: (preview: AdoptOutcome) => Promise<string[]>
}

async function adopt(opts: AdoptOptions): Promise<void> {
  warnIfRetiredNoCache(opts)
  const adoption = await adoptRun(opts, process.cwd())
  // `--yes` already agreed, so one engine call does it and its outcome says what it took: only the
  // named objects, or with nothing named, every conflict found as it runs.
  if (opts.yes) await adoptAgreed(adoption)
  else await adoptAsking(adoption)
}

async function adoptRun(opts: AdoptOptions, cwd: string): Promise<AdoptRun> {
  const config = loadConfig(cwd)
  const ast = await withSpinner("Loading schema", async () =>
    // As push sends it: the engine refuses a versioned schema that carries no publishing config.
    withPublishing(loadSchemaAst(schemaPathFromProject(config, cwd), cwd), config),
  )
  // Only the objects named change: no conflict is adopted unless --key names it, or nothing is named.
  const named = adoptableKeys(opts)
  const target = await schemaCommandTarget(cwd, config, opts)
  // Before the preview: the server or engine that adopts must take every flag given.
  await requireTargetFeatures(target, adoptNeeds({ release: opts.release, reclaim: opts.reclaim, keys: named }))
  const run = (yes: boolean, keys?: string[]): Promise<AdoptOutcome> =>
    targetSchemaAdopt(target, ast, {
      schema: pgSchema(config),
      yes,
      ...(opts.release !== undefined && { release: opts.release }),
      ...(opts.reclaim !== undefined && { reclaim: opts.reclaim }),
      ...(keys !== undefined && { keys }),
    })
  const columns = {
    entryPath: resolve(cwd, schemaPathFromProject(config, cwd)),
    cwd,
    // A column the database fills is declared as one only for an engine that reads it.
    identityColumns: (await targetCapabilities(target)).features.has("identity_columns"),
  }
  const introspect = (): Promise<unknown> => targetSchemaIntrospect(target, { schema: pgSchema(config) })
  return {
    named,
    run,
    requireKeys: (keys) => requireTargetFeatures(target, [adoptKeysNeed(keys)]),
    // An adopted column is managed, so the schema declares it from now on (see adopt-columns.ts).
    declare: async (outcome) => {
      await declareAdoptedColumns(
        outcome.adopt ?? [],
        { ...columns, yes: opts.yes ?? false, interactive: isInteractive() },
        {
          introspect,
          confirm: async (question) => (await confirm(question, { default: false })) === true,
          regenerate: () => regenerateTypes(cwd),
          say: { info, warn, plain },
        },
      )
    },
    // A column added outside Supatype is not a conflict, so the engine's preview does not list it.
    // Only for keys a person named with --key: `named` is also [] for a run that adopts nothing.
    columnLines: async (preview) =>
      opts.key === undefined ? [] : previewKeyedColumns(opts.key, previewedKeys(preview) ?? [], columns, { introspect }),
  }
}

/** `--yes`: adopt what was named in one call, then say what the next push would still refuse. */
async function adoptAgreed(adoption: AdoptRun): Promise<void> {
  const { named, run } = adoption
  // Read before applying: once the table is Supatype's, nothing else is asked about it.
  const leftOut = named?.some(isTableKey) === true ? tableAccessConflicts(await run(false), named) : []
  await applyAndReport(adoption, named, leftOut, true)
}

/** Adopt `keys`, then say what was taken, and what of the table's access was left out. */
async function applyAndReport(
  { run, declare }: AdoptRun,
  keys: string[] | undefined,
  leftOut: readonly DoctorItem[],
  echo: boolean,
): Promise<void> {
  const outcome = await applying(() => run(true, keys))
  if (outcome === undefined) return
  if (echo) for (const line of previewLines(outcome)) plain(`  ${line}`)
  report(outcome)
  sayAccessLeftOut(leftOut)
  await declare(outcome)
}

/** Preview, offer each named table's access objects with it, then adopt on a yes. */
async function adoptAsking(adoption: AdoptRun): Promise<void> {
  const { named, run, requireKeys, columnLines } = adoption
  const full = await run(false)
  const { keys: withAccess, leftOut } = await offerTableAccess(full, named)
  const preview = keyedOnly(full, withAccess)
  if (!show([...previewLines(preview), ...(await columnLines(preview))], withAccess !== undefined)) return
  // The named objects are what is adopted. Otherwise what was just shown is what is agreed to:
  // applying names those conflicts, and the engine writes nothing if the database has changed
  // since. An engine from before the ledger names none.
  const keys = withAccess ?? previewedKeys(preview)
  // Before anyone is asked: applying sends what was shown, which the target must honour.
  if (named === undefined && keys !== undefined) await requireKeys(keys)
  if (!(await agreedToAdopt())) return
  await applyAndReport(adoption, keys, leftOut, false)
}

/** Whether the person agreed; without a terminal or `--yes`, nobody did, which is exit 1. */
async function agreedToAdopt(): Promise<boolean> {
  const consent = await askConsent("Go ahead?", false)
  if (consent === "needs-yes") {
    // Not a decline: a pipeline that forgot --yes adopted nothing, and must not pass as if it had.
    error("adopt needs --yes when not interactive")
    process.exitCode = 1
  }
  if (consent === "declined") plain("Adoption cancelled.")
  return consent === "given"
}

/**
 * With `--key table:x`, offer x's grants and policies that the preview also shows as conflicts, as
 * one group: adopted without them, the next push refuses them (DR2). Returns the keys to adopt and
 * the access objects left out. Without a terminal nothing is asked, and they are left out.
 */
async function offerTableAccess(
  preview: AdoptOutcome,
  named: string[] | undefined,
): Promise<{ keys: string[] | undefined; leftOut: DoctorItem[] }> {
  if (named === undefined) return { keys: named, leftOut: [] }
  const access = tableAccessConflicts(preview, named)
  if (access.length === 0) return { keys: named, leftOut: [] }
  plain("\nThe access objects of the table named are not Supatype's either:\n")
  for (const item of access) plain(`  ${adoptionKey(item)}  ${item.message}`)
  const group = isInteractive() && (await confirm("Adopt these grants and policies with the table?", { default: false }))
  return group ? { keys: [...named, ...access.map(adoptionKey)], leftOut: [] } : { keys: named, leftOut: access }
}

/** After adopting a table without its access objects: the next push refuses them, and how to adopt them. */
function sayAccessLeftOut(leftOut: readonly DoctorItem[]): void {
  if (leftOut.length === 0) return
  const keys = leftOut.map(adoptionKey)
  warn(
    `The adopted table's grants and policies were left as they are, so the next push refuses them: ${keys.join(", ")}.`,
  )
  plain(`Adopt them with: supatype adopt ${keys.map((key) => `--key ${key}`).join(" ")}`)
}

/**
 * The outcome of applying, or undefined, having said so and set exit 1, when the engine refused
 * because an object it was to adopt is no longer a conflict.
 */
async function applying(apply: () => Promise<AdoptOutcome>): Promise<AdoptOutcome | undefined> {
  try {
    return await apply()
  } catch (err: unknown) {
    if (!isStalePreview(err) && !isEngineBusy(err)) throw err
    // Nothing was written either way: the engine refused before it took anything.
    error(isEngineBusy(err) ? ENGINE_BUSY_MESSAGE : STALE_PREVIEW_MESSAGE)
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
