/**
 * Database failures, told apart by Postgres's SQLSTATE rather than by the wording of the message.
 *
 * The wording changes with the server's `lc_messages` and between Postgres versions; the code does
 * not. A SQL proxy that passes the code on (`{ code: "42501" }` beside its message) is read by it.
 * One that does not leaves only the message, so every check here falls back to the wording.
 */

import { escapeRegExp } from "./utils.js"

/** The SQLSTATEs Studio acts on. */
export const SQLSTATE = {
  insufficientPrivilege: "42501",
  invalidSchemaName: "3F000",
  undefinedTable: "42P01",
} as const

const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/

/** A failed SQL call: its message, and its SQLSTATE when the proxy passed one on. */
export interface DatabaseFailure {
  message: string
  code: string | null
}

/** An error thrown by a SQL call, carrying the SQLSTATE the proxy answered with. */
export class DatabaseError extends Error {
  readonly code: string | null

  constructor(message: string, code: string | null) {
    super(message)
    this.name = "DatabaseError"
    this.code = code
  }
}

/**
 * The SQLSTATE on a thrown error or an error body: its `code`, when that has a SQLSTATE's shape.
 * Anything else called `code` (Cloud's `"sql_error"`, an HTTP status) is not one.
 */
export function sqlstateOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("code" in value)) return null
  const { code } = value
  return typeof code === "string" && SQLSTATE_SHAPE.test(code) ? code : null
}

/** pgx's error text, which the self-host server answers with: `ERROR: … (SQLSTATE 42P01)`. */
const SQLSTATE_SUFFIX = /\(SQLSTATE ([0-9A-Z]{5})\)\s*$/

/** The SQLSTATE a proxy put in its message text, for a proxy that sends no `code` field. */
export function sqlstateInMessage(message: string): string | null {
  return SQLSTATE_SUFFIX.exec(message)?.[1] ?? null
}

/**
 * Whether a failed read of `table` (schema-qualified, such as `_supatype.seeds`) is that table, or
 * its schema, not being there. Never a missing column, which is a table that is there.
 */
export function isMissingTable(failure: DatabaseFailure, table: string): boolean {
  if (failure.code !== null) {
    return failure.code === SQLSTATE.undefinedTable || failure.code === SQLSTATE.invalidSchemaName
  }
  const schema = table.split(".")[0] ?? table
  // `column … of relation "t" does not exist` names the relation too, and is not this.
  const relation = `(?<!of )relation "${escapeRegExp(table)}" does not exist`
  return new RegExp(`${relation}|schema "${escapeRegExp(schema)}" does not exist`).test(failure.message)
}

/**
 * Whether a failed read of `table` (schema-qualified) is this role lacking a privilege on it: no
 * SELECT on the table, or no USAGE on its schema. Used where the query reads nothing but `table`,
 * so a privilege failure with a code can only be about it.
 */
export function isPermissionDenied(failure: DatabaseFailure, table: string): boolean {
  if (failure.code !== null) return failure.code === SQLSTATE.insufficientPrivilege
  const [schema = table, name = table] = table.split(".")
  // Postgres 15 and later say "table"; earlier releases say "relation".
  const object = `(?:schema ${escapeRegExp(schema)}|(?:table|relation) ${escapeRegExp(name)})`
  // Not a longer name that starts with this one, such as `managed_objects_v2`.
  return new RegExp(`permission denied for ${object}(?![\\w$])`).test(failure.message)
}
