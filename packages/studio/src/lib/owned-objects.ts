/**
 * Which database objects are Supatype's: the ones its ledger (`_supatype.managed_objects`) records
 * and has not released, and, on a database an older engine pushed, the ones it stamped
 * `supatype:managed` in their comment before the ledger existed. Nothing writes that stamp any
 * more; a push moves it into the ledger the first time it finds one.
 *
 * Worth a badge because an object that is not Supatype's will not be maintained by a push, and
 * will not be dropped by one either.
 */

import { useApiQuery } from "../hooks/useApiQuery.js"
import type { ProjectProxy } from "../hooks/useProjectProxy.js"
import { sqlText } from "./sql.js"

const STAMP_PREFIX = "supatype:managed"

const NONE: ReadonlySet<string> = new Set()

/** How an owned object is looked up: its table and its name. */
export function ownedKey(table: string, name: string): string {
  return `${table}.${name}`
}

/** The ledger's objects in `schema` that are Supatype's. */
export function ownedObjectsQuery(schema: string): string {
  return `SELECT parent, name FROM _supatype.managed_objects
 WHERE schema_name = ${sqlText(schema)} AND status <> 'released' AND parent <> ''`
}

/**
 * The owned objects in `schema`, keyed by `ownedKey`. A database with no ledger yet (no push from
 * an engine that keeps one) owns nothing by it, so the failed read is that, not an error.
 */
export function useOwnedObjects(proxy: ProjectProxy, schema: string): ReadonlySet<string> {
  const { data } = useApiQuery(
    () =>
      proxy
        .sql(ownedObjectsQuery(schema))
        .then((r) => new Set(r.rows.map((row) => ownedKey(String(row["parent"]), String(row["name"])))))
        .catch((): ReadonlySet<string> => NONE),
    [proxy, schema],
  )
  return data ?? NONE
}

/** Whether the object `name` on `table`, with comment `comment`, is Supatype's. */
export function isOwned(owned: ReadonlySet<string>, table: unknown, name: unknown, comment: unknown): boolean {
  const stamped = typeof comment === "string" && comment.startsWith(STAMP_PREFIX)
  return stamped || owned.has(ownedKey(String(table), String(name)))
}
