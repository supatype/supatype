/**
 * A push that would drop data needs a person's say, wherever it runs.
 *
 * `supatype dev` pushed every schema change with `--force --non-interactive`, and the docker
 * `supatype push` did the same. A rename the engine did not recognise was therefore a dropped
 * column and a new empty one, with every value gone and nothing printed about it. Pushes now go
 * unforced: the engine refuses a destructive change, and this asks in a terminal, or refuses with
 * the command that applies it on purpose anywhere else.
 *
 * Renames are declared in the schema, never guessed (D1). When the engine names a drop and an add
 * a person may have meant as a rename, a terminal is asked about that first, and a yes writes the
 * declaration through a {@link RenameDeclarationWriter} and pushes again.
 */
import { engineOutputOf } from "./adopt-walkthrough.js"
import type { DiffResult, RenameCandidate } from "./engine-client.js"
import { plannedChanges } from "./diff-output.js"
import { confirm } from "./ui/confirm.js"
import { isInteractive } from "./ui/interactive.js"
import { plain, warn } from "./ui/messages.js"

/** The engine's refusal of an unforced push that would drop something, as it words it. */
const DESTRUCTIVE_REFUSAL = /(\d+) destructive operation\(s\) detected/i

/** What a refused rename means, said with every refusal. */
export const DESTRUCTIVE_CHANGE_HINT =
  "If you renamed a field: renames are applied only when the schema declares them, so this push " +
  "would drop the column and its data and add an empty one. Rename it back, or declare the rename, " +
  "to keep the data."

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

/**
 * Writes a rename declaration into the project's schema, so the next push applies it as a rename
 * and keeps the data. Pluggable: how a rename is declared in `schema/index.ts` is a separate
 * decision, and nothing is offered until a caller passes one.
 */
export interface RenameDeclarationWriter {
  write(candidate: RenameCandidate): Promise<void>
}

export interface DestructiveConsentDeps {
  ask?: (question: string) => Promise<boolean>
  interactive?: () => boolean
  /** What the push would destroy, one line each. Best effort: a failure only loses the list. */
  describe?: () => Promise<string[]>
  /** The drops and adds the engine says may be renames. Best effort, like `describe`. */
  renameCandidates?: () => Promise<RenameCandidate[]>
  /**
   * Writes a declaration the person agreed to. With it (and `renameCandidates`), a terminal is
   * asked "was this a rename?" before "drop the data?", and a yes pushes again. The push given to
   * {@link pushConsentingToDestructive} must then read the schema afresh each time it runs.
   */
  renameWriter?: RenameDeclarationWriter
}

/** The line a rename candidate is asked about with. */
export function renameLabel(candidate: RenameCandidate): string {
  return candidate.kind === "table"
    ? `table ${candidate.from} -> ${candidate.to}`
    : `${candidate.table}.${candidate.from} -> ${candidate.to}`
}

/**
 * Asks about each candidate in turn, skipping one whose source or target an earlier yes took, and
 * writes the declaration on a yes. Returns how many were written; none when either dep is absent.
 */
export async function offerRenames(
  deps: DestructiveConsentDeps,
  ask: (question: string) => Promise<boolean>,
): Promise<number> {
  const writer = deps.renameWriter
  if (writer === undefined || deps.renameCandidates === undefined) return 0
  const candidates = await deps.renameCandidates().catch((): RenameCandidate[] => [])
  const taken = new Set<string>()
  let written = 0
  for (const candidate of candidates) {
    const from = `${candidate.kind}:${candidate.table}:${candidate.from}`
    const to = `${candidate.kind}:${candidate.table}:${candidate.to}`
    if (taken.has(from) || taken.has(to)) continue
    if (!(await ask(`Was this a rename: ${renameLabel(candidate)}? (writes the declaration)`))) continue
    await writer.write(candidate)
    taken.add(from)
    taken.add(to)
    written++
  }
  return written
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
    // A declaration written is a different schema: push it again, asking about what is left, with
    // no second round of rename offers.
    if ((await offerRenames(deps, ask)) > 0) {
      const again: DestructiveConsentDeps = { ...deps }
      delete again.renameWriter
      return pushConsentingToDestructive(push, policy, again)
    }
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
