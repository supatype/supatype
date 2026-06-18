import type { DiffResult, Operation } from "./engine-client.js"

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

/** Print engine diff warnings before the operation list. */
export function printDiffWarnings(diff: DiffResult): void {
  const warnings = diff.warnings ?? []
  if (warnings.length === 0) return
  console.log(`\n${warnings.length} warning(s):\n`)
  for (const w of warnings) {
    console.log(`  [!] ${w}`)
  }
  console.log()
}

const RISK_SYMBOL: Record<NonNullable<DiffResult["operations"][number]["risk"]>, string> = {
  safe: "+",
  warn: "~",
  cautious: "~",
  danger: "!",
  destructive: "!",
}

const RISK_LEGEND: Record<NonNullable<DiffResult["operations"][number]["risk"]>, string> = {
  safe: "safe",
  warn: "caution",
  cautious: "caution",
  danger: "DANGER",
  destructive: "DANGER",
}

/** Print planned schema operations from a diff result. */
export function printDiffOperations(diff: DiffResult): void {
  const ops = diff.operations ?? []
  if (ops.length === 0) {
    console.log("No changes.")
    return
  }

  console.log(`\n${ops.length} change(s):\n`)
  for (const op of ops) {
    const r = op.risk ?? "safe"
    const label = op.warning ?? formatOperation(op)
    console.log(`  [${RISK_SYMBOL[r]}] ${label}  (${RISK_LEGEND[r]})`)
  }

  const dangerous = ops.filter((o) => o.risk === "danger").length
  if (dangerous > 0) {
    console.log(`\n  ${dangerous} dangerous operation(s). Review before pushing.`)
  }
  console.log()
}
