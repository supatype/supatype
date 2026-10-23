/**
 * A push that would drop data needs a person's say, wherever it runs.
 *
 * `supatype dev` pushed every schema change with `--force --non-interactive`, and the docker
 * `supatype push` did the same. A rename the engine did not recognise was therefore a dropped
 * column and a new empty one, with every value gone and nothing printed about it. Pushes now go
 * unforced: the engine refuses a destructive change, and this asks in a terminal, or refuses with
 * the command that applies it on purpose anywhere else.
 *
 * Renames are declared, never guessed (D1). When the engine names a drop and an add a person may
 * have meant as a rename, a terminal is asked about that first, and a yes is recorded in the
 * project's rename journal through a {@link RenameDeclarationWriter} and the push runs again. Off a
 * terminal the refusal names `supatype rename`, which records the same answer.
 */
import type { DiffResult, RenameCandidate } from "./engine-client.js"
import { plannedChanges, withoutEngineForceAdvice } from "./diff-output.js"
import { consentRefusal, engineOutputOf } from "./push-refusal.js"
import { RENAME_JOURNAL_FILE, journalRenameWriter, renameCommandHint } from "./rename-journal.js"
import { confirm } from "./ui/confirm.js"
import { isInteractive } from "./ui/interactive.js"
import { plain, warn } from "./ui/messages.js"

/** What a refused rename means, said when the engine pairs the drop with an add in the same push. */
export const DESTRUCTIVE_CHANGE_HINT =
  "If you renamed a field: renames are applied only when they are recorded, so this push would drop " +
  "the column and its data and add an empty one. Rename it back, or record the rename with " +
  "`supatype rename <table>.<from> <table>.<to>`, to keep the data."

/** What a refused plain drop means: nothing is added in its place. */
export const PLAIN_DROP_HINT =
  "This push would delete that data for good. To keep it, put the field back in your schema."

/** Which refusal a person is shown: a table rewrite, a plain drop, or a drop that may be a rename. */
type RefusalKind = "rewrite" | "drop" | "maybe-rename"

/**
 * A refused drop may be a rename when the engine pairs it with an add in the same push. Without the
 * candidates to look at (no dep, or the diff failed) the rename hint is kept, as it was.
 */
async function dropRefusalKind(deps: DestructiveConsentDeps): Promise<RefusalKind> {
  const candidates = await deps.renameCandidates?.().catch(() => undefined)
  return candidates !== undefined && candidates.length === 0 ? "drop" : "maybe-rename"
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
 * Records a rename a person confirmed, so the next push applies it as a rename and keeps the data:
 * the rename journal's writer (`journalRenameWriter`). Nothing is offered until a caller passes one.
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

/**
 * What a push's call site gives {@link pushConsentingToDestructive}, from one diff of the schema it
 * pushes: what would be lost, the renames it may be, and the rename journal of the project at `cwd`
 * to record a yes in. `diff` runs once per refusal: a yes changes the schema, so the next refusal
 * diffs again.
 */
export function consentDepsFromDiff(cwd: string, diff: () => Promise<DiffResult | undefined>): DestructiveConsentDeps {
  let pending: Promise<DiffResult | undefined> | undefined
  const once = () => (pending ??= diff())
  const journal = journalRenameWriter(cwd)
  return {
    describe: async () => {
      const found = await once()
      return found === undefined ? [] : destructiveLines(found)
    },
    renameCandidates: async () => (await once())?.renameCandidates ?? [],
    renameWriter: {
      write: async (candidate) => {
        pending = undefined
        await journal.write(candidate)
      },
    },
  }
}

/** The question a rename candidate is asked about with. */
export function renameQuestion(candidate: RenameCandidate): string {
  const what =
    candidate.kind === "table"
      ? `table ${candidate.from} renamed to ${candidate.to}`
      : `${candidate.table}.${candidate.from} renamed to ${candidate.table}.${candidate.to}`
  return `Was ${what}? (recorded in ${RENAME_JOURNAL_FILE})`
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
    if (!(await ask(renameQuestion(candidate)))) continue
    await writer.write(candidate)
    taken.add(from)
    taken.add(to)
    written++
  }
  return written
}

/** What became of the renames a push was offered: how many a terminal recorded, or the commands
 * that record them where there is no terminal to ask on. */
export interface SettledRenames {
  written: number
  hint: string[]
}

/**
 * The rename offer, wherever a push is planned or refused: a terminal is asked about each
 * candidate and a yes is recorded ({@link offerRenames}); anywhere else, the `supatype rename`
 * command that records each one is returned, for CI and agents to run and push again.
 */
export async function settleRenames(
  deps: DestructiveConsentDeps,
  interactive: boolean,
  ask: (question: string) => Promise<boolean>,
): Promise<SettledRenames> {
  if (deps.renameWriter === undefined || deps.renameCandidates === undefined) return { written: 0, hint: [] }
  if (interactive) return { written: await offerRenames(deps, ask), hint: [] }
  const candidates = await deps.renameCandidates().catch((): RenameCandidate[] => [])
  if (candidates.length === 0) return { written: 0, hint: [] }
  return {
    written: 0,
    hint: [
      "If any of these was a rename, record it and push again:",
      ...candidates.map((candidate) => `  ${renameCommandHint(candidate)}`),
    ],
  }
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
 * Push unforced; on the engine's refusal of a destructive change or of a rewrite of a large table
 * (IN-C 3), ask in a terminal and push again with `force` on a yes. Throws
 * {@link DestructiveChangeRefused} when nothing was applied, and rethrows every other failure as it
 * came.
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
    const refusal = consentRefusal(output)
    if (refusal === null) throw err
    if (policy.yes) return push(true)
    const rewrite = refusal.kind === "rewrite"
    if (rewrite) showRewrite(refusal.count, output)
    else await showDestruction(refusal.count, deps.describe)
    const message = refusalMessage(output, policy, rewrite ? "rewrite" : await dropRefusalKind(deps))
    const interactive = (deps.interactive ?? isInteractive)()
    const ask = deps.ask ?? ((question: string) => confirm(question, { default: false }))
    const renames = rewrite ? { written: 0, hint: [] } : await settleRenames(deps, interactive, ask)
    if (!interactive) throw new DestructiveChangeRefused([message, ...renames.hint].join("\n"))
    const refused = new DestructiveChangeRefused(message)
    // A declaration written is a different schema: push it again, asking about what is left, with
    // no second round of rename offers.
    if (renames.written > 0) {
      const again: DestructiveConsentDeps = { ...deps }
      delete again.renameWriter
      return pushConsentingToDestructive(push, policy, again)
    }
    const question = rewrite ? "Apply it and lock the table while it is rewritten?" : "Apply it and lose that data?"
    if (!(await ask(question))) throw refused
    return push(true)
  }
}

async function showDestruction(count: number, describe?: () => Promise<string[]>): Promise<void> {
  warn(`This schema change would drop data: ${count} destructive operation(s).`)
  const lines = await (describe?.() ?? Promise.resolve([])).catch(() => [])
  for (const line of lines) plain(`  [!] ${line}`)
}

/** Each rewrite the engine named, from its refusal: "items.qty ...: locks items while it ...". */
function showRewrite(count: number, output: string): void {
  warn(
    `This schema change rewrites a large table, which stops every read and write on it until the push commits: ` +
      `${count} operation(s).`,
  )
  const named = /rewrite a large table, which stops every read and write on it until the push commits: (.*?)\. Use --force/i
  const list = named.exec(output)?.[1]
  for (const line of list?.split("; ") ?? []) plain(`  [!] ${line}`)
}

function refusalMessage(output: string, policy: DestructiveConsentPolicy, kind: RefusalKind): string {
  const engineLine = withoutEngineForceAdvice(
    output.split(/\r?\n/).find((line) => consentRefusal(line) !== null)?.trim() ?? output.trim(),
  )
  if (kind === "rewrite") {
    return [
      `Nothing was applied. ${engineLine}`,
      `To apply it on purpose, at a quiet time for that table, run \`${policy.apply}\`.`,
    ].join("\n")
  }
  return [
    `Nothing was applied. ${engineLine}`,
    kind === "drop" ? PLAIN_DROP_HINT : DESTRUCTIVE_CHANGE_HINT,
    `To drop it on purpose, run \`${policy.apply}\`.`,
  ].join("\n")
}
