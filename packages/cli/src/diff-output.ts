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

/** The kinds that decide who may read or write: drift on them needs a person's consent. */
const ACCESS_KINDS = new Set(["policy", "table_grant", "security_label", "rls_attributes"])

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
    lines.push(...driftLines(`${kindLabel(action)} ${where(action)}`, recorded ?? "", action.action === "recreate" ? null : live ?? ""))
  }
  return lines
}

function driftLines(label: string, recorded: string, live: string | null): string[] {
  const lines = [`  ${label}`, "    Supatype's:"]
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
}

/**
 * The objects a security-drift refusal names, or null when `output` is not one. Read from the JSON
 * line the engine binary prints on stdout (or a server's JSON error body).
 */
export function securityDriftRefusal(output: string): DriftedObject[] | null {
  for (const line of output.split(/\r?\n/)) {
    const candidate = line.trim()
    if (!candidate.startsWith("{")) continue
    try {
      const parsed = JSON.parse(candidate) as { reason?: unknown; objects?: unknown }
      if (parsed.reason === SECURITY_DRIFT && Array.isArray(parsed.objects)) return parsed.objects as DriftedObject[]
    } catch {
      /* not this line */
    }
  }
  return null
}

/** Each object a refusal names, with what Supatype recorded beside what the database holds now. */
export function formatDriftedObjects(objects: readonly DriftedObject[]): string[] {
  return objects.flatMap((o) =>
    driftLines(`${o.key.kind.replace(/_/g, " ")} ${o.key.parent ? `${o.key.parent}.${o.key.name}` : o.key.name}`, o.recorded, o.live ?? null),
  )
}
