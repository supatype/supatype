/**
 * Plan 3.5 for the push itself: the engine refuses to put back access changed outside Supatype,
 * naming the objects, and the CLI shows them and asks. The docker provider has no diff to read
 * first, and on every other target a hand edit can land between the diff and the push (C08).
 *
 * A yes runs the push again with `--overwrite-drift`; anything else leaves the hand edits in place.
 * A push that cannot ask (`--yes`, no terminal) never takes that consent for itself.
 */
import { formatDriftedObjects } from "./diff-output.js"
import { classifyPushRefusal } from "./push-refusal.js"
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
    const refusal = classifyPushRefusal(err)
    if (refusal?.kind !== "security-drift") throw err
    // Nobody to ask: the command says what drifted and how to put it back (`explainingRefusal`).
    if (policy.yes || !(deps.interactive ?? isInteractive)()) throw err
    plain(`\n${refusal.objects.length} object(s) that decide who may read or write were changed outside Supatype:\n`)
    for (const line of formatDriftedObjects(refusal.objects)) plain(line)
    if (!(await askToOverwrite(deps))) return undefined
    await deps.beforeOverwrite?.()
    return push(true)
  }
}

/**
 * The question both push paths end on, once what drifted is shown: yes to put Supatype's
 * definitions back. A no keeps the hand edits, applies nothing and exits 1, on the docker path and
 * on a linked or self-hosted target alike, so a script sees the same refusal whichever ran it.
 */
export async function askToOverwrite(deps: Pick<DriftConsentDeps, "ask"> = {}): Promise<boolean> {
  const ask = deps.ask ?? (async (q: string) => (await confirm(q, { default: false })) === true)
  if (await ask("Put Supatype's definitions back?")) return true
  plain("Aborted. The changes made outside Supatype were kept; nothing was applied.")
  process.exitCode = 1
  return false
}
