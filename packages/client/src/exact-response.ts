/**
 * Reading a response body without losing the columns a double cannot hold.
 *
 * Joins the two halves: the registry says which columns are exact-value kinds, `exact-values` keeps
 * their digits intact across the parse. Kept apart from both so neither has to know about the
 * other, and so the decision about what to do when the kinds are unknown lives in one place.
 */
import {
  coerceExactKinds,
  findLossyNumbers,
  quoteExactNumbers,
  type ExactFields,
} from "./exact-values.js"
import { fieldKindsAreRegistered, registeredFieldsFor } from "./field-kinds-registry.js"

/**
 * Either the parsed rows, or the reason they could not be read without corrupting something.
 *
 * A result rather than an exception, because every other failure in this client is reported
 * through `QueryResult.error` and a lone throw from the parse path would be the odd one out.
 */
export type ExactParse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string; readonly columns: readonly string[] }

/** The table a PostgREST path names, for looking its columns up. */
export function tableFromPath(path: string): string {
  const withoutPrefix = path.replace(/^\/rest\/v1\//, "")
  const [table] = withoutPrefix.split("?")
  return table ?? withoutPrefix
}

/**
 * Parse a response body, keeping exact-value columns exact.
 *
 * When a numeric literal would lose its value and the column is not one the generated code
 * described, this reports a failure rather than returning a wrong number. There is deliberately no
 * fallback to asking the database: reconstructing the answer always succeeds, which would make a
 * project that never generated indistinguishable from one that did.
 */
export function parseRowsExactly(body: string, table: string): ExactParse {
  const fields: ExactFields = registeredFieldsFor(table)
  const rewritten = quoteExactNumbers(body, fields)

  // Anything still lossy is a column nothing described: the known ones are strings by now.
  const stranded = findLossyNumbers(rewritten)
  if (stranded.length === 0) {
    return { ok: true, value: coerceExactKinds(JSON.parse(rewritten), fields) }
  }

  return { ok: false, columns: stranded, message: describe(table, stranded) }
}

function describe(table: string, columns: readonly string[]): string {
  const named = columns.join(", ")
  const which = columns.length === 1 ? "column" : "columns"

  if (!fieldKindsAreRegistered()) {
    return (
      `The ${which} ${named} on ${table} returned a value that JavaScript cannot hold exactly, and ` +
      `this project's generated types have not been loaded, so Supatype does not know which ` +
      `columns to keep exact. Run \`supatype push\` and import the client from the generated file:` +
      `\n\n  import { createClient } from "./supatype/client"\n\n` +
      `Reading it as a number would have silently changed the value, so it has not guessed.`
    )
  }

  return (
    `The ${which} ${named} on ${table} returned a value that JavaScript cannot hold exactly, and ` +
    `the generated types do not describe it as one Supatype knows how to keep exact, so it has ` +
    `not guessed. The usual cause is an embedded resource: a column reached through an embed is ` +
    `left alone, because the select that produced it is not parsed here. Selecting it directly ` +
    `rather than through an embed returns it exactly. If the column is new, \`supatype push\` ` +
    `regenerates the types.`
  )
}
