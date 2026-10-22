import { useEffect, useState } from "react"
import type { SupatypeClient } from "@supatype/client"
import type { ModelConfig } from "../config.js"
import { isJsonObject } from "../lib/json.js"
import { useAdminClient } from "./useAdminClient.js"
import {
  affordanceColumn,
  fieldAffordanceColumn,
  needsPerRecordCheck,
  perRecordFieldChecks,
  type FieldOperation,
  type RecordFieldAccess,
  type StudioFieldAccess,
} from "./useStudioFieldAccess.js"

/** One record's answers to the verdicts only it can settle. */
export interface RecordAccess {
  /** null = not asked or not answerable. Only ever set from the database's own answer. */
  deletable: boolean | null
  fields: RecordFieldAccess
}

const UNASKED: RecordAccess = { deletable: null, fields: {} }

/** A computed column to ask the record for, and what its answer decides. */
type RecordCheck =
  | { affordance: string; kind: "delete" }
  | { affordance: string; kind: "field"; column: string; operation: FieldOperation }

/**
 * Ask one record what this caller may do with it, where the table-level answer is `row`.
 *
 * Deliberately its own query rather than extra columns on the record load: the affordances are not
 * columns of the record, and `serializeRecordForApi` spreads whatever is in the form's values
 * straight into the save body, so a computed column merged in there would be sent back as an
 * unknown column and fail every save. One query for all of them, so a record is asked once.
 *
 * Fails open: an error or a missing answer leaves every verdict unanswered, so the form behaves as
 * it did before it asked and the database refuses what it should.
 */
export function useRecordAccess(
  model: ModelConfig,
  recordId: string | undefined,
  access: StudioFieldAccess,
): RecordAccess {
  const client = useAdminClient()
  const [answer, setAnswer] = useState<RecordAccess>(UNASKED)

  useEffect(() => {
    const checks = recordChecks(access, model.tableName)
    if (recordId === undefined || checks.length === 0) {
      setAnswer(UNASKED)
      return
    }
    let cancelled = false
    void askRecord(client, model, recordId, checks).then((asked) => {
      if (!cancelled) setAnswer(asked)
    })
    return () => {
      cancelled = true
    }
  }, [client, access, model, recordId])

  return answer
}

function recordChecks(access: StudioFieldAccess, table: string): RecordCheck[] {
  const checks: RecordCheck[] = perRecordFieldChecks(access, table).map(({ column, operation }) => ({
    affordance: fieldAffordanceColumn(table, column, operation),
    kind: "field",
    column,
    operation,
  }))
  if (needsPerRecordCheck(access, table, "delete")) {
    checks.push({ affordance: affordanceColumn(table, "delete"), kind: "delete" })
  }
  return checks
}

async function askRecord(
  client: SupatypeClient,
  model: ModelConfig,
  recordId: string,
  checks: RecordCheck[],
): Promise<RecordAccess> {
  try {
    const result = await client
      .from(model.tableName)
      .select([model.primaryKey, ...checks.map((c) => c.affordance)].join(","))
      .eq(model.primaryKey, recordId)
      .single()
    const row: unknown = result.data
    return result.error !== null || !isJsonObject(row) ? UNASKED : answersOf(row, checks)
  } catch {
    return UNASKED
  }
}

/** The answers a row holds. A field answer that is not a boolean stays unanswered. */
function answersOf(row: Record<string, unknown>, checks: RecordCheck[]): RecordAccess {
  const answer: RecordAccess = { deletable: null, fields: {} }
  for (const check of checks) {
    const value = row[check.affordance]
    if (check.kind === "delete") answer.deletable = value === true
    else if (typeof value === "boolean") {
      answer.fields[check.column] = { ...answer.fields[check.column], [check.operation]: value }
    }
  }
  return answer
}

/** Each listed record's answers to its per-row read rules, by primary key. */
export type RowsFieldAccess = ReadonlyMap<string, RecordFieldAccess>

const NO_ROWS: RowsFieldAccess = new Map()

/**
 * Ask a page of records which per-row read rules let this caller see the value, so a list can tell
 * a withheld value from an empty one the way the edit form does for one record.
 *
 * Its own query over the page's keys rather than extra columns on the list read, so a failure here
 * costs only the padlocks, not the list. Fails open like {@link useRecordAccess}.
 */
export function useRowsFieldAccess(
  model: ModelConfig,
  rows: readonly Record<string, unknown>[],
  access: StudioFieldAccess,
): RowsFieldAccess {
  const client = useAdminClient()
  const [answer, setAnswer] = useState<RowsFieldAccess>(NO_ROWS)

  useEffect(() => {
    const checks = recordChecks(access, model.tableName).filter((c) => c.kind === "field" && c.operation === "read")
    const ids = rows.map((row) => String(row[model.primaryKey]))
    if (checks.length === 0 || ids.length === 0) {
      setAnswer(NO_ROWS)
      return
    }
    let cancelled = false
    void askRows(client, model, ids, checks).then((asked) => {
      if (!cancelled) setAnswer(asked)
    })
    return () => {
      cancelled = true
    }
  }, [client, access, model, rows])

  return answer
}

async function askRows(
  client: SupatypeClient,
  model: ModelConfig,
  ids: string[],
  checks: RecordCheck[],
): Promise<RowsFieldAccess> {
  try {
    const result = await client
      .from(model.tableName)
      .select([model.primaryKey, ...checks.map((c) => c.affordance)].join(","))
      .in(model.primaryKey, ids)
    const rows: unknown = result.data
    if (result.error !== null || !Array.isArray(rows)) return NO_ROWS
    const out = new Map<string, RecordFieldAccess>()
    for (const row of rows) {
      if (isJsonObject(row)) out.set(String(row[model.primaryKey]), answersOf(row, checks).fields)
    }
    return out
  } catch {
    return NO_ROWS
  }
}
