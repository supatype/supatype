/**
 * Building SQL for `proxy.sql`, which takes no parameters: anything that did not come from the
 * code itself (a schema picked, a filter typed) goes in through here.
 */

/** A Postgres string literal. */
export function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** A literal matching `value` anywhere under LIKE/ILIKE, with LIKE's own wildcards taken literally. */
export function containing(value: string): string {
  return sqlText(`%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
}
