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

/**
 * How an owned object is looked up: its ledger kind, its table and its name. The kind is part of
 * the key because names are only unique within a kind: a column, trigger or grant row can share a
 * name with an index or a constraint on the same table, and must not badge it.
 */
export function ownedKey(kind: string, table: string, name: string): string {
  return `${kind}:${table}.${name}`
}

/**
 * The ledger kinds an index can be recorded as: an index of its own, or the one Postgres builds for
 * a primary key or a unique constraint, which has the constraint's name.
 */
export const INDEX_KINDS: readonly string[] = ["index", "primary_key", "unique"]

/** The ledger kind for each constraint type ConstraintsView lists; `EXCLUDE` has none. */
export const CONSTRAINT_KINDS: Readonly<Record<string, readonly string[]>> = {
  "PRIMARY KEY": ["primary_key"],
  "FOREIGN KEY": ["foreign_key"],
  UNIQUE: ["unique"],
  CHECK: ["check"],
}

/** The ledger's objects in `schema` that are Supatype's. */
export function ownedObjectsQuery(schema: string): string {
  return `SELECT kind, parent, name FROM _supatype.managed_objects
 WHERE schema_name = ${sqlText(schema)} AND status <> 'released' AND parent <> ''`
}

/**
 * Whether a failed read is the ledger not being there: a database no engine with a ledger has
 * pushed to yet, which owns nothing by it. Anything else (a permission, a column an older ledger
 * lacks) is an error the screen has to show.
 */
export function isMissingLedger(message: string): boolean {
  return /_supatype\.managed_objects"? does not exist|schema "_supatype" does not exist/.test(message)
}

/** The owned objects, keyed by `ownedKey`, and why they could not be read, if they could not. */
export interface OwnedObjects {
  owned: ReadonlySet<string>
  error: string | null
}

/** The owned objects in `schema`. A missing ledger owns nothing; any other failure is reported. */
export function useOwnedObjects(proxy: ProjectProxy, schema: string): OwnedObjects {
  const { data, error } = useApiQuery(
    () =>
      proxy
        .sql(ownedObjectsQuery(schema))
        .then(
          (r): ReadonlySet<string> =>
            new Set(r.rows.map((row) => ownedKey(String(row["kind"]), String(row["parent"]), String(row["name"])))),
        ),
    [proxy, schema],
  )
  if (error !== null) return { owned: NONE, error: isMissingLedger(error) ? null : error }
  return { owned: data ?? NONE, error: null }
}

/** Whether the object `name` on `table`, recorded as one of `kinds`, with comment `comment`, is Supatype's. */
export function isOwned(
  owned: ReadonlySet<string>,
  kinds: readonly string[],
  table: unknown,
  name: unknown,
  comment: unknown,
): boolean {
  const stamped = typeof comment === "string" && comment.startsWith(STAMP_PREFIX)
  return stamped || kinds.some((kind) => owned.has(ownedKey(kind, String(table), String(name))))
}
