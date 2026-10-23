/**
 * The names the schema engine gives its generated predicates, so realtime can find them in
 * `pg_proc` without a label pointing at them.
 *
 * Built with `makeObjectName` from `@supatype/shared`, the port of the engine's `make_object_name`
 * that the CLI cuts table and column names with too, so the two cannot drift.
 */

import { makeObjectName } from "@supatype/shared"

export { makeObjectName }

/**
 * `can_read_<table>`, the row predicate. The engine never numbers it: each takes its own table's
 * row type, so two that clip to the same name are still two functions, and the lookup by exact
 * signature finds the right one. It is not in the recorded mapping, so this is how it is found.
 */
export function rowReadPredicateName(table: string): string {
  return makeObjectName("can_read", table, "")
}

/**
 * `can_read_<table>__<column>`, a column's read predicate, as the engine names it when no other
 * field predicate of the table has already taken that name. Two columns long enough to clip to the
 * same name get a numbered variant instead, which this does not reproduce: the caller treats a
 * predicate it cannot attribute to exactly one column as a reason to stop, not to guess.
 *
 * Only the fallback for a database last pushed by an engine before 0.7.0: from 0.7.0 the engine
 * records which predicate decides each column (`capabilities.fieldMasking.columns`), numbered ones
 * included, and realtime reads that instead.
 */
export function fieldReadPredicateName(table: string, column: string): string {
  return makeObjectName(`can_read_${table}_`, column, "")
}
