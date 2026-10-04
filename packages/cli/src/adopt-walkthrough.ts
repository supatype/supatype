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
import { EngineError } from "./engine-client.js"
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

/** One object `adopt` hands over or takes back, as the engine names it. */
export interface AdoptionItem {
  kind: string
  table: string
  name: string
  message: string
}

/**
 * What the engine's `adopt` reports, previewing or applying. Since the ledger it lists the objects
 * it hands over (`adopt`) and takes back (`release`) and writes ledger rows; an engine from before
 * listed the comment stamps it would write (`stampStatements`) and counted them (`stamped`).
 */
export interface AdoptOutcome {
  status?: string
  adopt?: AdoptionItem[]
  release?: AdoptionItem[]
  stampStatements?: string[]
  stamped?: number
}

/** What adopting would take, one line per object, whichever engine answered. */
export function adoptionLines(outcome: AdoptOutcome): string[] {
  return outcome.adopt?.map((item) => item.message) ?? outcome.stampStatements ?? []
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
  const adopted = await steps.apply()
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

/** Adoption through a deploy target, for the push walkthrough on a direct or local target. */
export function targetAdoptionSteps(adopt: (yes: boolean) => Promise<AdoptOutcome>): AdoptionSteps {
  return {
    preview: async () => adoptionLines(await adopt(false)),
    apply: async () => adoptedCount(await adopt(true)),
  }
}
