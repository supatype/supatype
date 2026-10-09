/**
 * What a push does when the engine refuses tables Supatype does not manage.
 *
 * Those tables exist and Supatype did not create them: made by hand, restored from a dump, or
 * created by a Supatype too old to record them. Push refuses them because their declared access
 * rules are not in force, and `adopt` is the remedy. It used to end there, with a message naming a
 * command, and the command it named could not reach a docker database (supatype#85) and found
 * nothing to adopt when it did (supatype#86).
 *
 * So in a terminal the push offers to adopt them there and then: it says which tables, shows what
 * adoption would take, and asks twice before taking it. Anywhere else it never adopts, because
 * agreeing to a push is not agreeing to take ownership of tables, and it prints the command instead.
 */
import { ENGINE_BUSY, EngineError, type AdoptOutcome, type DoctorItem } from "./engine-client.js"
import { TargetApiError } from "./target-client.js"
import { confirm } from "./ui/confirm.js"
import { isInteractive } from "./ui/interactive.js"
import { plain, warn } from "./ui/messages.js"

/** The `reason` the engine gives this refusal in its JSON output and its HTTP response. */
export const UNMANAGED_MODEL_TABLES = "unmanaged_model_tables"

/** An engine older than the JSON refusal says this and nothing machine-readable. */
const LEGACY_WORDING = /declares model\(s\) for table\(s\) Supatype does not manage: ([^\n]+?)\.(?:\n|$)/i

/**
 * The tables an unmanaged-tables refusal names, or null when the output is not that refusal.
 *
 * Read from the engine's JSON line first. The wording is only a fallback for an engine image that
 * predates it, which is what a pinned version can still be.
 */
export function unmanagedTables(output: string): string[] | null {
  for (const line of output.split(/\r?\n/)) {
    const candidate = line.trim()
    if (!candidate.startsWith("{")) continue
    try {
      const parsed = JSON.parse(candidate) as { reason?: unknown; tables?: unknown }
      if (parsed.reason === UNMANAGED_MODEL_TABLES && Array.isArray(parsed.tables)) {
        return parsed.tables.filter((t): t is string => typeof t === "string")
      }
    } catch {
      /* not this line */
    }
  }
  const legacy = LEGACY_WORDING.exec(output)
  return legacy?.[1] ? legacy[1].split(",").map((t) => t.trim()).filter((t) => t !== "") : null
}

/** Everything a failed push printed: the engine's stdout carries the JSON refusal. */
export function engineOutputOf(err: unknown): string {
  if (err instanceof EngineError) return `${err.message}\n${err.stdout}`
  return err instanceof Error ? err.message : String(err)
}

/** What adopting would take, one line per object, whichever engine answered. */
export function adoptionLines(outcome: AdoptOutcome): string[] {
  return outcome.adopt?.map((item) => item.message) ?? outcome.stampStatements ?? []
}

/**
 * The kinds the engine names without a table (`kind:name`), as `ObjectKind::table_level` lists
 * them; every other kind is `kind:table.name`.
 */
const TABLE_LEVEL_KINDS = new Set(["schema", "table", "function", "view", "enum_type", "sequence", "cron_job"])

/** An object as the engine's `adopt --key` (and the `keys` request field) names it. */
export function adoptionKey(item: Pick<DoctorItem, "kind" | "table" | "name">): string {
  return TABLE_LEVEL_KINDS.has(item.kind) ? `${item.kind}:${item.name}` : `${item.kind}:${item.table}.${item.name}`
}

/**
 * The conflicts a preview showed, named for the engine, so applying adopts those and nothing the
 * database grew since. Undefined for an engine from before the ledger, which names none.
 */
export function previewedKeys(outcome: AdoptOutcome): string[] | undefined {
  return outcome.adopt?.map(adoptionKey)
}

/** What the CLI says when the engine refused previewed keys that are no longer conflicts. */
export const STALE_PREVIEW_MESSAGE = "The database changed since the preview; run `supatype adopt` again."

/** Whether `err` is the engine refusing to adopt what a preview showed because it has changed. */
export function isStalePreview(err: unknown): boolean {
  return /changed since the preview/i.test(engineOutputOf(err))
}

/** How many objects an applied adopt took, whichever engine answered. */
export function adoptedCount(outcome: AdoptOutcome): number {
  return outcome.adopt?.length ?? outcome.stamped ?? 0
}

/** How to adopt, wherever the database is. */
export interface AdoptionSteps {
  /** What adoption would take, one line per object, without taking it. */
  preview: () => Promise<string[]>
  /** Take it, returning how many objects were adopted. */
  apply: () => Promise<number>
}

export interface AdoptionPolicy {
  /** `--yes`: the caller agreed to a push without being asked, which is not agreeing to adopt. */
  yes: boolean
  /** The command that would retry the push, named in what this prints. */
  retry: string
}

export type AdoptionOutcome = "adopted" | "declined"

/** Say what the refusal means, and offer to adopt in a terminal. */
export async function offerAdoption(
  tables: readonly string[],
  steps: AdoptionSteps,
  policy: AdoptionPolicy,
): Promise<AdoptionOutcome> {
  warn(
    `${tables.length === 1 ? "This table exists" : "These tables exist"} and Supatype did not create ` +
      `${tables.length === 1 ? "it" : "them"}, so the access rules your schema declares for ` +
      `${tables.length === 1 ? "it are" : "them are"} not in force: ${tables.join(", ")}.`,
  )
  const manual = `Run \`supatype adopt\` to bring ${tables.length === 1 ? "it" : "them"} under management ` +
    `(it shows what it takes first), then \`${policy.retry}\` again.`
  if (policy.yes || !isInteractive()) {
    plain(manual)
    return "declined"
  }
  if (!(await confirm("Adopt them now?", { default: false }))) {
    plain(manual)
    return "declined"
  }
  return adoptAfterPreview(steps, manual)
}

/**
 * Whether `err` is the engine refusing because another push, adopt or rebaseline holds its lock:
 * nothing was written, and trying again is the answer. From the binary, or a server's 409.
 */
export function isEngineBusy(err: unknown): boolean {
  if (err instanceof EngineError) return err.reason === ENGINE_BUSY
  if (err instanceof TargetApiError) {
    return err.status === 409 && (err.code === ENGINE_BUSY || /another push, adopt or rebaseline is running/i.test(err.message))
  }
  return false
}

/** What the CLI says when adopt met a busy engine. */
export const ENGINE_BUSY_MESSAGE =
  "The database is busy: another push, adopt or rebaseline is running on it. Nothing was adopted; try again."

async function adoptAfterPreview(steps: AdoptionSteps, manual: string): Promise<AdoptionOutcome> {
  const lines = await steps.preview()
  if (lines.length === 0) {
    warn("Adoption found nothing to adopt, so nothing was changed.")
    plain(manual)
    return "declined"
  }
  plain(`\nAdoption will take:\n`)
  for (const line of lines) plain(`  ${line}`)
  if (!(await confirm("Adopt these?", { default: false }))) {
    plain(manual)
    return "declined"
  }
  let adopted: number
  try {
    adopted = await steps.apply()
  } catch (err: unknown) {
    if (!isStalePreview(err) && !isEngineBusy(err)) throw err
    // Nothing was written, so the push is still refused for the reason it was.
    warn(isEngineBusy(err) ? ENGINE_BUSY_MESSAGE : STALE_PREVIEW_MESSAGE)
    plain(manual)
    return "declined"
  }
  plain(`Adopted ${adopted} object(s).`)
  return "adopted"
}

/**
 * Push, and when the engine refuses unmanaged tables, offer to adopt them and push once more.
 *
 * Any other failure, a declined offer, or a second refusal is thrown as it came, so the caller's
 * exit code still says the push did not happen.
 */
export async function pushOfferingAdoption<T>(
  push: () => Promise<T>,
  steps: AdoptionSteps,
  policy: AdoptionPolicy,
): Promise<T> {
  try {
    return await push()
  } catch (err: unknown) {
    const tables = unmanagedTables(engineOutputOf(err))
    if (tables === null || tables.length === 0) throw err
    if ((await offerAdoption(tables, steps, policy)) !== "adopted") throw err
    return push()
  }
}

/**
 * Adoption through a deploy target, for the push walkthrough on a direct or local target.
 *
 * Applying adopts what the preview showed and nothing else: the engine is sent the previewed keys.
 * `beforeKeys` (the engine version gate) runs once the preview names some, before anyone is asked.
 */
export function targetAdoptionSteps(
  adopt: (yes: boolean, keys?: string[]) => Promise<AdoptOutcome>,
  beforeKeys: (keys: string[]) => Promise<void> = async () => undefined,
): AdoptionSteps {
  let keys: string[] | undefined
  return {
    preview: async () => {
      const outcome = await adopt(false)
      keys = previewedKeys(outcome)
      if (keys !== undefined) await beforeKeys(keys)
      return adoptionLines(outcome)
    },
    apply: async () => adoptedCount(await (keys === undefined ? adopt(true) : adopt(true, keys))),
  }
}
