import { useCallback, useMemo } from "react"
import { useProjectProxy } from "./useProjectProxy.js"
import { useApiQuery } from "./useApiQuery.js"
import { cellText } from "../views/metadata-row.js"

type Row = Record<string, unknown>

/** A schema's policies by the table they guard, each table's row security, and how to re-read both. */
export interface PolicyCatalogue {
  grouped: Map<string, Row[]>
  rlsMap: Map<string, boolean>
  loading: boolean
  error: string | null
  refresh: () => void
}

/** Whether the catalogue's `rls_enabled` says on, which arrives as a boolean or as Postgres's `t`. */
export function rlsIsOn(row: Row): boolean {
  const value = row["rls_enabled"]
  return value === true || value === "t"
}

/** Rows by the table they belong to, in the order the catalogue listed them. */
export function groupByTable(rows: Row[]): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>()
  for (const row of rows) {
    const table = cellText(row, "tablename") || "(unknown)"
    const list = grouped.get(table)
    if (list) list.push(row)
    else grouped.set(table, [row])
  }
  return grouped
}

const ALL_ROWS = (): boolean => true

/**
 * The schema's policies and row security, read through the metadata catalogue (RQ3b), so a viewer
 * sees them too. `keep` narrows both to the rows a view shows, such as storage's own tables.
 */
export function usePolicyCatalogue(schema: string, keep: (row: Row) => boolean = ALL_ROWS): PolicyCatalogue {
  const proxy = useProjectProxy()
  const policies = useApiQuery(() => proxy.metadata("policies", { schema }).then((r) => r.rows), [proxy, schema])
  const rls = useApiQuery(() => proxy.metadata("rls_status", { schema }).then((r) => r.rows), [proxy, schema])
  const { refetch: refetchPolicies } = policies
  const { refetch: refetchRls } = rls
  const refresh = useCallback(() => { refetchPolicies(); refetchRls() }, [refetchPolicies, refetchRls])
  const grouped = useMemo(() => groupByTable((policies.data ?? []).filter(keep)), [policies.data, keep])
  const rlsMap = useMemo(() => new Map((rls.data ?? []).filter(keep).map((r) => [cellText(r, "tablename"), rlsIsOn(r)])), [rls.data, keep])
  return { grouped, rlsMap, loading: policies.loading, error: policies.error, refresh }
}
