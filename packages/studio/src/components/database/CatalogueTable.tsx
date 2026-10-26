import React from "react"
import { useApiQuery, type ApiQueryResult } from "../../hooks/useApiQuery.js"
import { useProjectProxy, type MetadataName } from "../../hooks/useProjectProxy.js"
import { Button, LoadingRows, TableCard, Td } from "../ui.js"
import { EmptyState } from "../EmptyState.js"
import { DROP_LOOK } from "./DropPolicyButton.js"

/**
 * The list each Database screen (tables, functions, triggers, views, types) draws of one catalogue
 * query, on the shared table primitives: placeholder rows while it loads, a plain empty state when
 * the schema has none, and otherwise a table card with a row per object.
 */

type Row = Record<string, unknown>

/** One catalogue query's rows in `schema`, refetched when the schema changes. */
export function useCatalogueRows(name: MetadataName, schema: string): ApiQueryResult<Row[]> {
  const proxy = useProjectProxy()
  return useApiQuery(() => proxy.metadata(name, { schema }).then((r) => r.rows), [proxy, name, schema])
}

/** The rows a screen lists, whether they are still loading, and what it says when there are none. */
export interface CatalogueList {
  rows: Row[] | null
  loading: boolean
  empty: { title: string; description: string }
}

/** The catalogue as a table card under `head`, drawing each row with `row`. */
export function CatalogueTable({ list, head, row }: {
  list: CatalogueList
  head: React.ReactNode
  row: (row: Row, index: number) => React.ReactNode
}): React.ReactElement {
  if (list.loading) return <LoadingRows />
  if (list.rows?.length === 0) return <EmptyState title={list.empty.title} description={list.empty.description} />
  return <TableCard head={head}>{(list.rows ?? []).map(row)}</TableCard>
}

/**
 * The last cell of a row: its actions, at the right. A click here acts on the button pressed and
 * does not also open the row.
 */
export function RowActions({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Td className="text-right" onClick={(e) => { e.stopPropagation() }}>
      <span className="flex items-center justify-end gap-1">{children}</span>
    </Td>
  )
}

/** An action on one row that only opens something, such as its data or its draft for editing. */
export function RowButton({ label, onClick }: { label: string; onClick: () => void }): React.ReactElement {
  return <Button size="xs" variant="ghost" className="text-primary hover:text-primary" onClick={onClick}>{label}</Button>
}

/** Drop on one row, in the look every Drop in a Database list has. */
export function DropRowButton({ onDrop }: { onDrop: () => void }): React.ReactElement {
  return <Button {...DROP_LOOK} onClick={onDrop}>Drop</Button>
}
