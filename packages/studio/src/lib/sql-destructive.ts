/**
 * Whether reviewed SQL drops or destroys something, and so asks a second question before it runs.
 *
 * Owner rule: every screen that runs reviewed SQL asks again only for a statement that drops,
 * empties, overwrites, revokes or opens up what was protected. Creating, replacing or enabling runs
 * straight after review. The rule reads the statement as it will run, so a draft edited in the box
 * is judged by what it now says, not by the button that opened it.
 */

/**
 * Comments, string literals, quoted identifiers and dollar-quoted bodies, earliest first, so a
 * keyword inside any of them (a function body's `DELETE`, a table named `"drop"`) is not read as
 * the statement's own.
 */
const NOT_CODE = /\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$|--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"/g

/** Statements that destroy by what they are. `DO` runs a body this rule cannot read, so it asks. */
const DESTRUCTIVE_VERBS = new Set(["DROP", "TRUNCATE", "DELETE", "UPDATE", "REVOKE", "DO"])

/** What makes an `ALTER` destructive: dropping part of an object, or switching row security off. */
const DESTRUCTIVE_ALTER = /\bDROP\b|\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b|\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i

/** A data-modifying statement inside a `WITH`. */
const DESTRUCTIVE_CTE = /\bDELETE\s+FROM\b|\bUPDATE\s+\S+\s+SET\b|\bTRUNCATE\b/i

/**
 * `sql` with its comments, literals and bodies blanked to spaces, character for character, so a
 * statement found in it sits at the same place in `sql`. A quoted name becomes underscores rather
 * than spaces: it is still a name, so `UPDATE "posts" SET` keeps a word where the table goes.
 */
function blanked(sql: string): string {
  return sql.replace(NOT_CODE, (m) => m.replace(/[^\n]/g, m.startsWith('"') ? "_" : " "))
}

/** One statement: its code with everything else blanked, and its text as written. */
interface Statement {
  code: string
  text: string
}

/** `sql` split into its statements at the semicolons that are code, not inside a literal or a body. */
function statements(sql: string): Statement[] {
  const found: Statement[] = []
  let at = 0
  for (const part of blanked(sql).split(";")) {
    if (part.trim() !== "") found.push({ code: part.trim(), text: sql.slice(at, at + part.length).trim() })
    at += part.length + 1
  }
  return found
}

/** Whether one statement, already stripped of everything that is not code, destroys something. */
function destroys(statement: string): boolean {
  const verb = (/^[A-Za-z]+/.exec(statement)?.[0] ?? "").toUpperCase()
  if (DESTRUCTIVE_VERBS.has(verb)) return true
  if (verb === "ALTER") return DESTRUCTIVE_ALTER.test(statement)
  if (verb === "WITH") return DESTRUCTIVE_CTE.test(statement)
  return false
}

/** Each statement in `sql` that drops or destroys something, as written, in order. */
export function destructiveStatements(sql: string): string[] {
  return statements(sql).filter((s) => destroys(s.code)).map((s) => s.text)
}

/** Whether any statement in `sql` drops or destroys something. */
export function isDestructiveSql(sql: string): boolean {
  return statements(sql).some((s) => destroys(s.code))
}
