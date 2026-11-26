/**
 * What to say under a SQL editor error that reads like a Studio fault but is not one.
 *
 * The Postgres image loads pg_safeupdate for every session, the SQL editor's included, so a
 * DELETE or UPDATE with no WHERE fails with "DELETE requires a WHERE clause". Matched on the
 * message, since its SQLSTATE (21000, cardinality violation) is shared with unrelated errors.
 */
const SAFEUPDATE = /\b(DELETE|UPDATE) requires a WHERE clause\b/

/** A hint for `message`, or null when the error needs none. */
export function sqlErrorHint(message: string): string | null {
  const statement = SAFEUPDATE.exec(message)?.[1]
  if (statement === undefined) return null
  return (
    `The database refuses a ${statement} with no WHERE in every session (pg_safeupdate), ` +
    "so a whole table is never changed by accident. To change every row, write WHERE true."
  )
}
