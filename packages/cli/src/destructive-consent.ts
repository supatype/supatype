/**
 * A push that would drop data needs a person's say, wherever it runs.
 *
 * `supatype dev` pushed every schema change with `--force --non-interactive`, and the docker
 * `supatype push` did the same. A rename the engine did not recognise was therefore a dropped
 * column and a new empty one, with every value gone and nothing printed about it. Pushes now go
 * unforced: the engine refuses a destructive change, and this asks in a terminal, or refuses with
 * the command that applies it on purpose anywhere else.
 */
import { engineOutputOf } from "./adopt-walkthrough.js"
import type { DiffResult } from "./engine-client.js"
import { plannedChanges } from "./diff-output.js"
import { confirm } from "./ui/confirm.js"
import { isInteractive } from "./ui/interactive.js"
import { plain, warn } from "./ui/messages.js"

/** The engine's refusal of an unforced push that would drop something, as it words it. */
const DESTRUCTIVE_REFUSAL = /(\d+) destructive operation\(s\) detected/i

/** What a refused rename means, said with every refusal. */
export const DESTRUCTIVE_CHANGE_HINT =
  "If you renamed a field, the engine did not recognise it as a rename and would drop the column " +
  "and its data. Rename it back to keep the data."

/** How many destructive operations the engine refused, or null when `output` is not that refusal. */
export function destructiveRefusal(output: string): number | null {
  const match = DESTRUCTIVE_REFUSAL.exec(output)
  return match?.[1] === undefined ? null : Number(match[1])
}

/** The changes a diff would make that lose data, one line each. */
export function destructiveLines(diff: Pick<DiffResult, "operations" | "reconcile">): string[] {
  return plannedChanges(diff)
    .filter((change) => change.risk === "destructive" || change.risk === "danger")
    .map((change) => change.label)
}

export interface DestructiveConsentPolicy {
  /** `push --yes`: consent given up front. `dev` never sets it. */
  yes: boolean
  /** The command that applies the change on purpose, named when nothing was applied. */
  apply: string
}

export interface DestructiveConsentDeps {
  ask?: (question: string) => Promise<boolean>
  interactive?: () => boolean
  /** What the push would destroy, one line each. Best effort: a failure only loses the list. */
  describe?: () => Promise<string[]>
}

/** A destructive push that was not applied: declined, or nobody there to ask. */
export class DestructiveChangeRefused extends Error {
  override readonly name = "DestructiveChangeRefused"
}

/** What dev says, in both providers: it never forces, and `push` is where data is dropped on purpose. */
export const DEV_DESTRUCTIVE_POLICY: DestructiveConsentPolicy = {
  yes: false,
  apply: "supatype push --yes",
}

/**
 * Push unforced; on the engine's destructive refusal, ask in a terminal and push again with
 * `force` on a yes. Throws {@link DestructiveChangeRefused} when nothing was applied, and rethrows
 * every other failure as it came.
 */
export async function pushConsentingToDestructive<T>(
  push: (force: boolean) => Promise<T>,
  policy: DestructiveConsentPolicy,
  deps: DestructiveConsentDeps = {},
): Promise<T> {
  try {
    return await push(false)
  } catch (err: unknown) {
    const output = engineOutputOf(err)
    const count = destructiveRefusal(output)
    if (count === null) throw err
    if (policy.yes) return push(true)
    await showDestruction(count, deps.describe)
    const refused = new DestructiveChangeRefused(refusalMessage(output, policy))
    if (!(deps.interactive ?? isInteractive)()) throw refused
    const ask = deps.ask ?? ((question: string) => confirm(question, { default: false }))
    if (!(await ask("Apply it and lose that data?"))) throw refused
    return push(true)
  }
}

async function showDestruction(count: number, describe?: () => Promise<string[]>): Promise<void> {
  warn(`This schema change would drop data: ${count} destructive operation(s).`)
  const lines = await (describe?.() ?? Promise.resolve([])).catch(() => [])
  for (const line of lines) plain(`  [!] ${line}`)
}

function refusalMessage(output: string, policy: DestructiveConsentPolicy): string {
  const engineLine =
    output.split(/\r?\n/).find((line) => DESTRUCTIVE_REFUSAL.test(line))?.trim() ?? output.trim()
  return [
    `Nothing was applied. ${engineLine}`,
    DESTRUCTIVE_CHANGE_HINT,
    `To drop it on purpose, run \`${policy.apply}\`.`,
  ].join("\n")
}
