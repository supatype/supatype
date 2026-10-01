/**
 * What a push does when the engine refuses tables Supatype does not manage.
 *
 * Those tables exist without Supatype's ownership marker: made by hand, restored from a dump, or
 * created by a Supatype too old to stamp them. Push refuses them because their declared access
 * rules are not in force, and `adopt` is the remedy. It used to end there, with a message naming a
 * command, and the command it named could not reach a docker database (supatype#85) and found
 * nothing to stamp when it did (supatype#86).
 *
 * So in a terminal the push offers to adopt them there and then: it says which tables, shows the
 * SQL adoption would run, and asks twice before running it. Anywhere else it never adopts, because
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

/** How to adopt, wherever the database is. */
export interface AdoptionSteps {
  /** The stamp statements adoption would run, without running them. */
  preview: () => Promise<string[]>
  /** Run them, returning how many objects were stamped. */
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
    `${tables.length === 1 ? "This table exists" : "These tables exist"} without Supatype's ownership ` +
      `marker, so the access rules your schema declares for ${tables.length === 1 ? "it are" : "them are"} ` +
      `not in force: ${tables.join(", ")}.`,
  )
  const manual = `Run \`supatype adopt\` to bring ${tables.length === 1 ? "it" : "them"} under management ` +
    `(it shows the SQL first), then \`${policy.retry}\` again.`
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
  const statements = await steps.preview()
  if (statements.length === 0) {
    warn("Adoption found nothing to stamp, so nothing was changed.")
    plain(manual)
    return "declined"
  }
  plain(`\nAdoption will run:\n`)
  for (const sql of statements) plain(`  ${sql}`)
  if (!(await confirm("Apply these stamps?", { default: false }))) {
    plain(manual)
    return "declined"
  }
  const stamped = await steps.apply()
  plain(`Adopted: ${stamped} object(s) stamped.`)
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
export function targetAdoptionSteps(
  adopt: (yes: boolean) => Promise<{ stampStatements?: string[]; stamped?: number }>,
): AdoptionSteps {
  return {
    preview: async () => (await adopt(false)).stampStatements ?? [],
    apply: async () => (await adopt(true)).stamped ?? 0,
  }
}
