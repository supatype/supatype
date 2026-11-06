import type { DiffResult, Operation, ReconcileAction } from "./engine-client.js"
import { findJsonLine } from "./engine-json-line.js"
import { isArrayOf, isShape, isString, nullable, optional, type Guard } from "@supatype/shared"

/** The engine's own advice to rerun it with its `--force` flag, with the "(destructive)" it may carry. */
const ENGINE_FORCE_ADVICE = /\s*Use --force to proceed(?:\s*\([^)]*\))?\.?/gi

/**
 * An engine sentence without its advice to pass `--force`.
 *
 * That flag is the engine binary's. No CLI command takes it: consent is `push --yes`, or a yes in a
 * terminal, and the CLI says so itself. Passed through, the engine's line told a person to use a
 * flag that `supatype push` rejects.
 */
export function withoutEngineForceAdvice(text: string): string {
  return text.replace(ENGINE_FORCE_ADVICE, "")
}

type Risk = NonNullable<Operation["risk"]>

/** One thing a push will do, from either side of the engine's plan. */
export interface PlannedChange {
  label: string
  risk: Risk
  /**
   * What the change's own statement also makes: a check or foreign key inside its CREATE TABLE or
   * ADD COLUMN. Shown beneath it, and neither counted nor confirmed on its own.
   */
  details?: string[]
}

/** `foreign_key` as a person says it: `foreign key`. */
function kindLabel(action: ReconcileAction): string {
  return action.key.kind.replace(/_/g, " ")
}

function where(action: ReconcileAction): string {
  const { parent, name } = action.key
  return parent ? `${parent}.${name}` : name
}

/** `PUBLIC` as the ledger names it: a keyword for every role, which nothing is ever granted to. */
const PUBLIC_GRANTEE = "PUBLIC"

/**
 * A table grant's change, said as what its statement does, or null for another kind. The engine's
 * object for one role is "revoke everything, then grant exactly this set", and for PUBLIC only the
 * revoke: it read as `create table grant posts.PUBLIC`, a grant nothing makes.
 */
function grantLabel(action: ReconcileAction): string | null {
  if (action.key.kind !== "table_grant") return null
  const { parent: table, name: role } = action.key
  const revoke = `revoke every privilege on ${table} from ${role}`
  const sets = role === PUBLIC_GRANTEE ? revoke : `set ${role}'s privileges on ${table}`
  switch (action.action) {
    case "create":
    case "replace":
      return sets
    case "recreate":
      return `${sets} (put back: removed outside Supatype)`
    case "drop":
      return revoke
    case "drift":
      return role === PUBLIC_GRANTEE
        ? `PUBLIC was given privileges on ${table} outside Supatype; the push revokes them`
        : `${role}'s privileges on ${table} were changed outside Supatype; the push puts them back`
    default:
      return null
  }
}

/**
 * What a reconcile action means for the database, or `null` when it is not a change of its own: a
 * `keep`, a `forget` (ledger only), a `released` object, or any action the engine marks `inline`
 * (a create, recreate, replace or drift fix its parent statement already makes, so it is neither
 * listed twice nor confirmed on its own: {@link plannedChanges} shows it under that statement).
 */
export function formatReconcileAction(action: ReconcileAction): PlannedChange | null {
  if (action.inline === true && action.action !== "conflict") return null
  const change = describeAction(action)
  if (change === null) return null
  const label = grantLabel(action)
  return label === null ? change : { ...change, label }
}

function describeAction(action: ReconcileAction): PlannedChange | null {
  const kind = kindLabel(action)
  const at = where(action)
  switch (action.action) {
    case "create":
      return { label: `create ${kind} ${at}`, risk: "safe" }
    case "adopt":
      return {
        label: `adopt ${kind} ${at} (already in the database, now recorded as Supatype's)`,
        risk: "safe",
      }
    case "conflict":
      return {
        label: `${kind} ${at} exists and was not created by Supatype; run \`supatype adopt\` or rename it`,
        risk: "danger",
      }
    case "recreate":
      return { label: `recreate ${kind} ${at} (dropped outside Supatype)`, risk: "cautious" }
    case "replace":
      return { label: `replace ${kind} ${at}`, risk: "safe" }
    case "drift":
      return {
        label: `${kind} ${at} was changed outside Supatype; the push puts it back`,
        risk: action.security_relevant ? "danger" : "cautious",
      }
    case "drop":
      return { label: `drop ${kind} ${at}`, risk: "cautious" }
    // `keep`, `forget` and `released` change nothing, and neither does an action this CLI does not
    // know (`restate`, `rename`, `rebuild` ride on a change the operations already list).
    default:
      return null
  }
}

/**
 * The inline kinds worth a line under their statement: what a schema declares (a check from a
 * string-literal union, a unique field, a reference). A primary key comes with every table, and a
 * line for it under each would hide the ones that say something.
 */
const SHOWN_INLINE_KINDS: ReadonlySet<string> = new Set(["check", "unique", "foreign_key"])

/** An inline action as a line under its statement: the object, and what happens to it if not a create. */
function inlineDetail(action: ReconcileAction): string | null {
  if (action.inline !== true || !SHOWN_INLINE_KINDS.has(action.key.kind)) return null
  const object = `${kindLabel(action)} ${action.key.name}`
  switch (action.action) {
    case "create":
      return object
    case "recreate":
      return `${object}, put back (dropped outside Supatype)`
    case "replace":
      return `${object}, replaced`
    case "drift":
      return `${object}, put back (changed outside Supatype)`
    default:
      return null
  }
}

/** The table an object's `parent` names: `posts` for `posts` and for `posts.title`. */
function parentTable(action: ReconcileAction): string {
  return action.key.parent.split(".")[0] ?? ""
}

/**
 * The operation whose statement makes an inline action: the first one on its table that creates
 * the table or adds a column, else the first on its table.
 */
function parentOperationIndex(operations: readonly Operation[], action: ReconcileAction): number {
  const table = parentTable(action)
  const onTable = (op: Operation) => op.table === table
  const makes = operations.findIndex((op) => onTable(op) && (op.type === "create_table" || op.type === "add_column"))
  return makes >= 0 ? makes : operations.findIndex(onTable)
}

/**
 * Everything a push of this plan will do: the differ's operations, then the reconcile's changes.
 * The one list `diff`, `push`, `deploy` and `migrate` count and confirm against, so a change the
 * reconcile plans (a check or a foreign key, say) is never a push that "matches the database".
 * Inline actions are details of the operation that makes them, not changes of their own.
 */
export function plannedChanges(diff: Pick<DiffResult, "operations" | "reconcile">): PlannedChange[] {
  const operations = diff.operations ?? []
  const changes: PlannedChange[] = operations.map((op) => ({
    // `AlterColumn` sends `warning: null` when it has nothing to warn about.
    label: typeof op.warning === "string" ? withoutEngineForceAdvice(op.warning) : formatOperation(op),
    risk: op.risk ?? "safe",
  }))
  for (const action of diff.reconcile ?? []) {
    const change = formatReconcileAction(action)
    if (change) changes.push(change)
    else attachInline(changes, operations, action)
  }
  return changes
}

/** Add an inline action to the details of the operation that makes it, when it is worth a line. */
function attachInline(changes: PlannedChange[], operations: readonly Operation[], action: ReconcileAction): void {
  const detail = inlineDetail(action)
  if (detail === null) return
  const parent = changes[parentOperationIndex(operations, action)]
  if (parent !== undefined) parent.details = [...(parent.details ?? []), detail]
}

/** Whether a change needs a person to say yes before a push applies it. */
export function isRisky(change: PlannedChange): boolean {
  return change.risk !== "safe"
}

/** Human-readable label for a single schema operation. */
export function formatOperation(op: Operation): string {
  if (typeof op.description === "string" && op.description.trim().length > 0) {
    return op.description
  }

  const kind = typeof op.type === "string" ? op.type : typeof op.kind === "string" ? op.kind : "operation"
  const { table, column, index } = op
  const sql = typeof op.sql === "string" ? op.sql.trim() : ""

  if (kind === "add_unique_constraint" || kind === "drop_unique_constraint") {
    const constraint = typeof op.constraint === "string" ? op.constraint : null
    if (typeof table === "string" && constraint) return `${kind} ${table}.${constraint}`
  }

  if (kind === "create_index" || kind === "drop_index" || kind === "add_index") {
    const indexName = typeof index === "string" ? index : typeof op.name === "string" ? op.name : null
    const fields = Array.isArray(op.fields) ? op.fields.join(", ") : null
    if (indexName && fields) return `${kind} ${table}.${indexName} (${fields})`
    if (indexName) return `${kind} ${table}.${indexName}`
  }

  if (typeof table === "string" && typeof column === "string") {
    return `${kind} ${table}.${column}`
  }
  if (typeof table === "string") {
    return `${kind} ${table}`
  }

  if (sql) {
    const oneLine = sql.replace(/\s+/g, " ").slice(0, 120)
    return `${kind}: ${oneLine}${sql.length > 120 ? "…" : ""}`
  }

  return kind
}

/** Print engine warnings: a diff's before its operation list, or a push's once it has run. */
export function printDiffWarnings(diff: Pick<DiffResult, "warnings">): void {
  const warnings = diff.warnings ?? []
  if (warnings.length === 0) return
  console.log(`\n${warnings.length} warning(s):\n`)
  for (const w of warnings) {
    console.log(`  [!] ${withoutEngineForceAdvice(w)}`)
  }
  console.log()
}

const RISK_SYMBOL: Record<Risk, string> = {
  safe: "+",
  warn: "~",
  cautious: "~",
  danger: "!",
  destructive: "!",
}

const RISK_LEGEND: Record<Risk, string> = {
  safe: "safe",
  warn: "caution",
  cautious: "caution",
  danger: "DANGER",
  destructive: "DANGER",
}

/** Print what a push of this plan will do: the operations and the reconcile's changes. */
export function printDiffOperations(diff: Pick<DiffResult, "operations" | "reconcile">): void {
  const changes = plannedChanges(diff)
  if (changes.length === 0) {
    // Ends with a blank line, as a list of changes does, so what follows starts apart from it.
    console.log("No changes.\n")
    return
  }

  console.log(`\n${changes.length} change(s):\n`)
  for (const change of changes) {
    console.log(`  [${RISK_SYMBOL[change.risk]}] ${change.label}  (${RISK_LEGEND[change.risk]})`)
    for (const detail of change.details ?? []) console.log(`      with ${detail}`)
  }

  const dangerous = changes.filter((c) => c.risk === "danger" || c.risk === "destructive").length
  if (dangerous > 0) {
    console.log(`\n  ${dangerous} dangerous change(s). Review before pushing.`)
  }
  console.log()
}

/** The kinds that decide who may read or write: drift on them needs a person's consent. */
const ACCESS_KINDS = new Set(["policy", "table_grant", "security_label", "rls_attributes"])

/** Whether objects of this kind decide who may read or write (the engine's `security_relevant`). */
export function isAccessKind(kind: string): boolean {
  return ACCESS_KINDS.has(kind)
}

/**
 * Plan 3.5: the policies, grants, labels and RLS attributes this push would put back because
 * they were changed or removed outside Supatype. A pipeline must not revert a deliberate hand
 * edit on the next deploy, and a rollback could not bring it back, so the engine refuses these
 * unless the push says to overwrite them.
 */
export function securityDrift(diff: Pick<DiffResult, "reconcile">): ReconcileAction[] {
  return (diff.reconcile ?? []).filter(
    (action) =>
      (action.action === "drift" && action.security_relevant === true) ||
      // The schema changed it too, so it is replaced rather than put back: the hand edit is
      // overwritten all the same, as the engine counts it.
      (action.action === "replace" && action.drifted !== undefined && ACCESS_KINDS.has(action.key.kind)) ||
      (action.action === "recreate" && ACCESS_KINDS.has(action.key.kind)),
  )
}

/** Each drifted object with what Supatype recorded beside what the database holds now. */
export function formatSecurityDrift(actions: ReconcileAction[]): string[] {
  const lines: string[] = []
  for (const action of actions) {
    const recorded =
      action.action === "drift"
        ? action.recorded_def
        : action.action === "replace"
          ? action.drifted?.recorded_def
          : action.create_sql
    const live =
      action.action === "drift" ? action.live_def : action.action === "replace" ? action.drifted?.live_def : undefined
    const unchecked = action.action === "replace" ? action.drifted?.unchecked : undefined
    lines.push(
      ...driftLines(`${kindLabel(action)} ${where(action)}`, recorded ?? "", action.action === "recreate" ? null : live ?? "", unchecked),
    )
  }
  return lines
}

function driftLines(label: string, recorded: string, live: string | null, unchecked?: string): string[] {
  const lines = [`  ${label}`]
  // The engine could not compare it with what Supatype made, so it counts it as changed (F16).
  if (unchecked !== undefined) {
    lines.push(`    Not checked for changes made by hand (${unchecked}), so it is treated as changed.`)
  }
  lines.push("    Supatype's:")
  for (const line of recorded.split("\n")) lines.push(`      ${line}`)
  if (live === null) {
    lines.push("    Now: removed")
  } else {
    lines.push("    Now:")
    for (const line of live.split("\n")) lines.push(`      ${line}`)
  }
  return lines
}

/** The `reason` the engine gives a push it refused over access changed outside Supatype. */
export const SECURITY_DRIFT = "security_drift"

/** One object that refusal names (schema-engine `ledger::drift::DriftedObject`). */
export interface DriftedObject {
  key: { kind: string; schema?: string; parent: string; name: string }
  /** What Supatype recorded, or for one removed by hand what it would make. */
  recorded: string
  /** What the database holds now; null when it was removed. */
  live?: string | null
  /** Why it could not be compared with what Supatype made, when it could not: it is treated as changed. */
  unchecked?: string
}

/**
 * The objects a security-drift refusal names, or null when `output` is not one. Read from the JSON
 * line the engine binary prints on stdout (or a server's JSON error body).
 */
export function securityDriftRefusal(output: string): DriftedObject[] | null {
  const line = findJsonLine(output, (value) => value["reason"] === SECURITY_DRIFT && isDriftedObjects(value["objects"]))
  const objects = line?.["objects"]
  return isDriftedObjects(objects) ? objects : null
}

/** The objects a security-drift refusal names (schema-engine `ledger::drift::DriftedObject`). */
export const isDriftedObjects: Guard<DriftedObject[]> = isArrayOf(
  isShape({
    key: isShape({ kind: isString, schema: optional(isString), parent: isString, name: isString }),
    recorded: isString,
    live: optional(nullable(isString)),
    unchecked: optional(isString),
  }),
)

/** Each object a refusal names, with what Supatype recorded beside what the database holds now. */
export function formatDriftedObjects(objects: readonly DriftedObject[]): string[] {
  return objects.flatMap((o) =>
    driftLines(
      `${o.key.kind.replace(/_/g, " ")} ${o.key.parent ? `${o.key.parent}.${o.key.name}` : o.key.name}`,
      o.recorded,
      o.live ?? null,
      o.unchecked,
    ),
  )
}
