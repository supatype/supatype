import { useEffect, useState } from "react"
import { actingModeOf, type ActingMode } from "../lib/acting-mode.js"
import { isJsonObject } from "../lib/json.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { studioGatewayHeaders } from "../lib/studio-gateway-headers.js"
import { useAdminClient } from "./useAdminClient.js"
import { membershipBase } from "../lib/membership-url.js"

/**
 * What this caller may do with one column, resolved as far as the server can without a row.
 *
 * `allow` and `deny` are settled for the whole table. `row` means the rule reads the row, so
 * the answer genuinely differs between records and the interface must not claim either way.
 */
export type FieldVerdict = "allow" | "deny" | "row"

export interface FieldAccess {
  read: FieldVerdict
  /** The UPDATE path. */
  write: FieldVerdict
  /**
   * The INSERT path, which is stricter: with no row yet, a write rule that reads the row
   * cannot be satisfied by anyone, so such a column is uncreatable rather than "ask per row".
   */
  create: FieldVerdict
}

/** `table -> column -> verdicts`. A table absent from the map has no field rules. */
export type FieldAccessMap = Record<string, Record<string, FieldAccess> | undefined>

/**
 * Whose identity data requests act as.
 *
 * `elevated` means the server swaps in the service role, which `supatype_mask` exempts, so
 * every restricted column comes back in the clear. The restrictions are then *descriptive*
 * rather than applied, and the interface must say so rather than pretend otherwise.
 *
 * `studio` keeps the caller's own identity, so every field rule applies to them as in `self`.
 * Only the row rules differ, and the server's session answer already says what the Studio role
 * may do with rows, so the verdicts below are read the same way in both.
 */
export type { ActingMode }

/** `table -> operation -> verdict`, for `read` / `create` / `update` / `delete`. */
export type TableAccessMap = Record<string, Record<string, FieldVerdict> | undefined>

export interface StudioFieldAccess {
  /** False until the answer arrives; the UI must not restrict on a guess. */
  resolved: boolean
  mode: ActingMode
  fields: FieldAccessMap
  /**
   * Table-level verdicts, which have shipped in `/studio/session` since P2.6 and were until now
   * unread: so Studio offered buttons the server would refuse.
   */
  tables: TableAccessMap
}

/**
 * Per-column access for the signed-in user, from `/studio/session`.
 *
 * Drives three things a blank cell cannot express: a lock where a value was withheld, a
 * disabled input where a column is readable but not writable, and the absence of a field
 * from a create form where no caller could supply it.
 *
 * **Fails open, deliberately.** If this cannot be read the interface behaves exactly as it
 * did before: the database still refuses what it should, and a save that fails is a far
 * better outcome than an interface that hides a field on the strength of a network error.
 * That is the same reason nothing here is an authorization decision: the enforcement is the
 * security labels and the query rewrite.
 */
export function useStudioFieldAccess(): StudioFieldAccess {
  const client = useAdminClient()
  const [state, setState] = useState<StudioFieldAccess>({
    resolved: false,
    mode: "self",
    fields: {},
    tables: {},
  })

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const base = membershipBase(client.url).replace(/\/admin$/, "")
        const res = await fetch(`${base}/studio/session`, {
          credentials: "include",
          headers: { ...studioGatewayHeaders(), ...studioAuthHeaders(client) },
        })
        if (!res.ok) return
        const json = await res.json()
        if (cancelled || !isJsonObject(json)) return
        setState({
          resolved: true,
          mode: actingModeOf(json["mode"]) ?? "self",
          fields: normaliseFieldAccess(json["fields"]),
          tables: normaliseTableAccess(json["access"]),
        })
      } catch {
        // Leave `resolved` false so the UI keeps its unrestricted behaviour.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [client])

  return state
}

/**
 * Keep only verdicts this build understands.
 *
 * A newer server may answer with something unrecognised; dropping it means the field behaves
 * as unrestricted, which is the same as not having asked. Inventing a meaning for it could
 * hide a column the caller is entitled to edit.
 */
export function normaliseFieldAccess(raw: unknown): FieldAccessMap {
  if (!isJsonObject(raw)) return {}

  const out: FieldAccessMap = {}
  for (const [table, columns] of Object.entries(raw)) {
    if (!isJsonObject(columns)) continue

    const resolved: Record<string, FieldAccess> = {}
    for (const [column, v] of Object.entries(columns)) {
      if (!isJsonObject(v)) continue
      resolved[column] = {
        read: verdictOf(v["read"]),
        write: verdictOf(v["write"]),
        create: verdictOf(v["create"]),
      }
    }
    if (Object.keys(resolved).length > 0) out[table] = resolved
  }

  return out
}

function verdictOf(value: unknown): FieldVerdict {
  return value === "deny" || value === "row" ? value : "allow"
}

/** Whether a column carries any read restriction at all, settled or per-row. */
export function isFieldRestricted(
  access: StudioFieldAccess,
  table: string,
  column: string,
): boolean {
  if (!access.resolved) return false
  const read = access.fields[table]?.[column]?.read
  return read === "deny" || read === "row"
}

/**
 * How one cell should be rendered.
 *
 * A restricted column that is simply *empty* must not be reported as withheld, otherwise a
 * record created without a value for it looks like a record hiding one. Whether a null can be
 * read as masking depends on both the acting mode and how settled the verdict is, so all three
 * inputs matter:
 *
 * - `plain`: no restriction; render normally.
 * - `hidden`: certainly withheld. Only when masking is actually being applied *and* the verdict
 *   denies every row, so a null cannot be anything else.
 * - `unknown`: restricted, null, and genuinely ambiguous: a `row` verdict means some records
 *   withhold and others are empty, and nothing here can tell which this is. Says so rather than
 *   guessing.
 * - `revealed`: the caller is seeing the true value, whatever it is. Marked so they know the
 *   column is access-controlled and others may not see it. Includes an elevated caller's empty
 *   cell: masking is not applied to them, so the emptiness is real.
 */
export type CellAccess = "plain" | "hidden" | "unknown" | "revealed"

export function cellAccess(
  access: StudioFieldAccess,
  table: string,
  column: string,
  value: unknown,
  record: RecordFieldAccess = {},
): CellAccess {
  if (!isFieldRestricted(access, table, column)) return "plain"

  // Elevated requests run as the service role, which the masking extension exempts. Nothing was
  // withheld, so a null is a genuine null and a lock would be a false claim.
  if (access.mode === "elevated") return "revealed"

  if (value !== null && value !== undefined) return "revealed"

  if (access.fields[table]?.[column]?.read === "deny") return "hidden"
  // A per-row rule the record itself answered is settled for that record, as on the edit form.
  const answered = record[column]?.read
  if (answered === undefined) return "unknown"
  return answered ? "plain" : "hidden"
}

/**
 * Whether a column can be edited on an existing record.
 *
 * True when elevated: the request will run as the service role, which the masking extension
 * exempts, so the write will succeed and disabling the input would be a lie the UI tells about
 * a restriction that is not being applied. Unknown also means "let the user try", the database
 * refuses what it should.
 */
export function isFieldWritable(
  access: StudioFieldAccess,
  table: string,
  column: string,
): boolean {
  return isFieldAllowedOnRecord(access, table, column, "write", {})
}

/** The two field operations a rule can decide per record. */
export type FieldOperation = "read" | "write"

const FIELD_OPERATIONS: readonly FieldOperation[] = ["read", "write"]

/**
 * One record's own answers to its per-row field rules, `column -> operation -> allowed`, from the
 * engine's per-row field functions. A column or operation missing from it has not been answered.
 */
export type RecordFieldAccess = Record<string, Partial<Record<FieldOperation, boolean>> | undefined>

/**
 * Whether the caller may read or write a column on one record.
 *
 * A settled verdict decides on its own. A `row` verdict takes the record's answer, and with no
 * answer it fails open as everything here does: the database still refuses what it should.
 */
export function isFieldAllowedOnRecord(
  access: StudioFieldAccess,
  table: string,
  column: string,
  operation: FieldOperation,
  record: RecordFieldAccess,
): boolean {
  if (!access.resolved || access.mode === "elevated") return true
  const verdict = access.fields[table]?.[column]?.[operation]
  if (verdict === "deny") return false
  return verdict !== "row" || record[column]?.[operation] !== false
}

/**
 * The field verdicts on a table that only a record can answer, so Studio asks the record for them.
 *
 * Empty when elevated or unresolved, for the same reasons as {@link needsPerRecordCheck}.
 */
export function perRecordFieldChecks(
  access: StudioFieldAccess,
  table: string,
): { column: string; operation: FieldOperation }[] {
  if (!access.resolved || access.mode === "elevated") return []
  const checks: { column: string; operation: FieldOperation }[] = []
  for (const [column, verdicts] of Object.entries(access.fields[table] ?? {})) {
    for (const operation of FIELD_OPERATIONS) {
      if (verdicts[operation] === "row") checks.push({ column, operation })
    }
  }
  return checks
}

/**
 * The engine's per-row field function for one column, which PostgREST exposes as a computed
 * column beside {@link affordanceColumn}'s. Emitted only for a column whose rule reads the row, so
 * it is requested only for a `row` verdict.
 */
export function fieldAffordanceColumn(table: string, column: string, operation: FieldOperation): string {
  return `can_${operation}_${table}__${column}`
}

/**
 * Whether a column belongs on a create form.
 *
 * A column no caller can supply is left out rather than rendered as an input that cannot be
 * satisfied: which for a required column would otherwise be a form that can never be
 * submitted. Elevated callers keep the field for the same reason as above: the insert will
 * run as the service role and succeed.
 */
export function isFieldCreatable(
  access: StudioFieldAccess,
  table: string,
  column: string,
): boolean {
  if (!access.resolved || access.mode === "elevated") return true
  return access.fields[table]?.[column]?.create !== "deny"
}

/**
 * Keep only the table-level verdicts this build understands, same reasoning as
 * {@link normaliseFieldAccess}.
 */
export function normaliseTableAccess(raw: unknown): TableAccessMap {
  if (!isJsonObject(raw)) return {}

  const out: TableAccessMap = {}
  for (const [table, operations] of Object.entries(raw)) {
    if (!isJsonObject(operations)) continue

    const resolved: Record<string, FieldVerdict> = {}
    for (const [operation, verdict] of Object.entries(operations)) {
      resolved[operation] = verdictOf(verdict)
    }
    out[table] = resolved
  }

  return out
}

/**
 * Whether Studio should offer an operation on a table at all.
 *
 * Only a settled `deny` withdraws the control. `row` means some records allow it, so the button
 * stays and the per-record answer decides, withdrawing it wholesale would hide an action the
 * caller does have on most of their rows.
 *
 * Elevated callers keep everything, because the request will run as the service role and
 * succeed; and an unresolved answer keeps everything, because the server refuses what it should
 * and an interface that removes controls on a failed request is worse than one that lets a
 * request be refused.
 */
export function isOperationOffered(
  access: StudioFieldAccess,
  table: string,
  operation: "read" | "create" | "update" | "delete",
): boolean {
  if (!access.resolved || access.mode === "elevated") return true
  return access.tables[table]?.[operation] !== "deny"
}

/**
 * Whether an operation's answer depends on the record, so Studio has to ask per record.
 *
 * True only for a `row` verdict. `allow` and `deny` are settled for the whole table, and an
 * elevated caller bypasses the rules entirely, so neither needs a per-record question.
 */
export function needsPerRecordCheck(
  access: StudioFieldAccess,
  table: string,
  operation: "read" | "create" | "update" | "delete",
): boolean {
  if (!access.resolved || access.mode === "elevated") return false
  return access.tables[table]?.[operation] === "row"
}

/**
 * The generated per-row affordance function for an operation, which PostgREST exposes as a
 * computed column.
 *
 * Requested only when {@link needsPerRecordCheck} is true: the engine emits one of these for
 * every model it manages, so asking for it on a table it does not manage would fail the whole
 * query rather than just this check.
 */
export function affordanceColumn(
  table: string,
  operation: "read" | "create" | "update" | "delete",
): string {
  return `can_${operation}_${table}`
}
