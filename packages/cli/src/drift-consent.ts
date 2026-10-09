/**
 * Plan 3.5 for a push that has no diff to read first (the docker provider): the engine refuses to
 * put back access changed outside Supatype, naming the objects, and the CLI shows them and asks.
 *
 * A yes runs the push again with `--overwrite-drift`; anything else leaves the hand edits in place.
 * A push that cannot ask (`--yes`, no terminal) never takes that consent for itself.
 */
import { engineOutputOf } from "./adopt-walkthrough.js"
import { formatDriftedObjects, securityDriftRefusal } from "./diff-output.js"
import { confirm } from "./ui/confirm.js"
import { isInteractive } from "./ui/interactive.js"
import { plain } from "./ui/messages.js"

export interface DriftConsentPolicy {
  /** `--overwrite-drift`: consent given up front, so the first push already sends it. */
  overwriteDrift: boolean
  /** `--yes`: agreeing to a push is not agreeing to overwrite a hand edit to access. */
  yes: boolean
}

export interface DriftConsentDeps {
  /** Before the push that overwrites: the engine must support it (the capability gate). */
  beforeOverwrite?: () => Promise<void>
  ask?: (question: string) => Promise<boolean>
  interactive?: () => boolean
}

/**
 * Push; on the engine's security-drift refusal show what drifted and, in a terminal, ask whether to
 * put Supatype's definitions back, pushing again with `overwriteDrift` on a yes. Returns undefined
 * when the person declined, having said so and set exit 1; rethrows every other failure.
 */
export async function pushConsentingToDrift<T>(
  push: (overwriteDrift: boolean) => Promise<T>,
  policy: DriftConsentPolicy,
  deps: DriftConsentDeps = {},
): Promise<T | undefined> {
  try {
    return await push(policy.overwriteDrift)
  } catch (err: unknown) {
    if (policy.overwriteDrift) throw err
    const objects = securityDriftRefusal(engineOutputOf(err))
    if (objects === null) throw err
    plain(`\n${objects.length} object(s) that decide who may read or write were changed outside Supatype:\n`)
    for (const line of formatDriftedObjects(objects)) plain(line)
    const interactive = (deps.interactive ?? isInteractive)()
    if (policy.yes || !interactive) {
      plain(
        "\nNothing was applied. Run the push interactively to review this, or pass --overwrite-drift to put Supatype's definitions back.",
      )
      throw err
    }
    const ask = deps.ask ?? (async (q: string) => (await confirm(q, { default: false })) === true)
    if (!(await ask("Put Supatype's definitions back?"))) {
      plain("Aborted. The changes made outside Supatype were kept; nothing was applied.")
      process.exitCode = 1
      return undefined
    }
    await deps.beforeOverwrite?.()
    return push(true)
  }
}
