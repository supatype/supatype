import type { DiffResult, Operation, ReconcileAction } from "./engine-client.js"

type Risk = NonNullable<Operation["risk"]>

/** One thing a push will do, from either side of the engine's plan. */
export interface PlannedChange {
  label: string
  risk: Risk
}

/** `foreign_key` as a person says it: `foreign key`. */
function kindLabel(action: ReconcileAction): string {
  return action.key.kind.replace(/_/g, " ")
}

function where(action: ReconcileAction): string {
  const { parent, name } = action.key
  return parent ? `${parent}.${name}` : name
}

/**
 * What a reconcile action means for the database, or `null` when it is not a change of its own: a
 * `keep`, a `forget` (ledger only), a `released` object, or any action the engine marks `inline`
 * (a create, recreate, replace or drift fix its parent statement already makes, so it is neither
 * listed twice nor confirmed on its own).
 */
export function formatReconcileAction(action: ReconcileAction): PlannedChange | null {
  if (action.inline === true && action.action !== "conflict") return null
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
    case "keep":
    case "forget":
    case "released":
      return null
  }
}

/**
 * Everything a push of this plan will do: the differ's operations, then the reconcile's changes.
 * The one list `diff`, `push`, `deploy` and `migrate` count and confirm against, so a change the
 * reconcile plans (a check or a foreign key, say) is never a push that "matches the database".
 */
export function plannedChanges(diff: Pick<DiffResult, "operations" | "reconcile">): PlannedChange[] {
  const changes: PlannedChange[] = (diff.operations ?? []).map((op) => ({
    label: op.warning ?? formatOperation(op),
    risk: op.risk ?? "safe",
  }))
  for (const action of diff.reconcile ?? []) {
    const change = formatReconcileAction(action)
    if (change) changes.push(change)
  }
  return changes
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
  const raw = op as unknown as Record<string, unknown>
  const table = raw["table"]
  const column = raw["column"]
  const index = raw["index"]
  const sql = typeof op.sql === "string" ? op.sql.trim() : ""

  if (kind === "add_unique_constraint" || kind === "drop_unique_constraint") {
    const constraint = typeof raw["constraint"] === "string" ? raw["constraint"] : null
    if (typeof table === "string" && constraint) return `${kind} ${table}.${constraint}`
  }

  if (kind === "create_index" || kind === "drop_index" || kind === "add_index") {
    const indexName = typeof index === "string" ? index : typeof raw["name"] === "string" ? raw["name"] : null
    const fields = Array.isArray(raw["fields"]) ? raw["fields"].join(", ") : null
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
    console.log(`  [!] ${w}`)
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
    console.log("No changes.")
    return
  }

  console.log(`\n${changes.length} change(s):\n`)
  for (const change of changes) {
    console.log(`  [${RISK_SYMBOL[change.risk]}] ${change.label}  (${RISK_LEGEND[change.risk]})`)
  }

  const dangerous = changes.filter((c) => c.risk === "danger" || c.risk === "destructive").length
  if (dangerous > 0) {
    console.log(`\n  ${dangerous} dangerous change(s). Review before pushing.`)
  }
  console.log()
}
