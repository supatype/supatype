import React, { useCallback, useState } from "react"
import { Badge, Pager, TableCard, Td, Th } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { UuidCell } from "../../components/UuidCell.js"
import { useInspectorResource } from "../../hooks/useInspectorResource.js"
import { isConnectionsData } from "../../lib/realtime-guards.js"
import type { InspectorTabProps } from "./InspectorTab.js"
import { InspectorFailureView, When } from "./shared.js"
import type { ConnectionSummary, ConnectionsData } from "./types.js"

const REFRESH_MS = 5000
/** Connections per page; realtime's own default, and under its maximum of 500. */
const CLIENTS_PAGE_SIZE = 100

/** One page of connections, starting after the connection id `after` ("" for the first page). */
function connectionsPath(after: string): string {
  const params = new URLSearchParams({ limit: String(CLIENTS_PAGE_SIZE) })
  if (after !== "") params.set("after", after)
  return `realtime/connections?${params.toString()}`
}

/** "12 of 500 connections" against a limit; just the count when there is none (self-host). */
export function connectionCount(data: Pick<ConnectionsData, "total" | "limit">): string {
  const noun = data.total === 1 ? "connection" : "connections"
  return data.limit === null ? `${data.total} ${noun}` : `${data.total} of ${data.limit} ${noun}`
}

function ClientRow({ connection }: { connection: ConnectionSummary }): React.ReactElement {
  const client = connection.client
  return (
    <tr className="border-b border-border hover:bg-accent/50">
      <Td className="font-mono text-xs">{connection.userId !== null ? <UuidCell value={connection.userId} /> : <span className="text-muted-foreground">not signed in</span>}</Td>
      <Td>{connection.role !== null ? <Badge variant="outline">{connection.role}</Badge> : null}</Td>
      <Td className="text-xs text-muted-foreground"><When at={connection.connectedAt} /></Td>
      <Td className="text-xs text-muted-foreground"><When at={connection.lastMessageAt} /></Td>
      <Td className="font-mono text-xs">{connection.channels.join(", ")}</Td>
      <Td className="text-xs text-muted-foreground" title={connection.userAgent ?? undefined}>
        {client === null ? "" : `${client.name}${client.version === null ? "" : ` ${client.version}`}`}
      </Td>
    </tr>
  )
}

/** The clients table and the count above it, given what realtime reported. */
export function ClientsTable({ data }: { data: ConnectionsData }): React.ReactElement {
  return (
    <div className="space-y-3">
      <p className="text-sm text-foreground">
        {connectionCount(data)}
        {data.tier !== null && <Badge variant="outline" className="ml-2">{data.tier}</Badge>}
      </p>
      {data.connections.length === 0 ? (
        <EmptyState title="No connected clients" description="Nothing is connected to realtime right now." />
      ) : (
        <TableCard head={<><Th>User</Th><Th>Role</Th><Th>Connected</Th><Th>Last message</Th><Th>Channels</Th><Th>Client</Th></>}>
          {data.connections.map((c) => <ClientRow key={c.id} connection={c} />)}
        </TableCard>
      )}
    </div>
  )
}

/**
 * Every connection, a page at a time with realtime's cursor. The page on screen keeps refreshing.
 * It used to read the first 100 and ignore `next`, so the rest were counted but never listed.
 */
export function Clients({ api }: InspectorTabProps): React.ReactElement {
  // The connection id each page starts after; the last one is the page on screen.
  const [cursors, setCursors] = useState<string[]>([""])
  const path = connectionsPath(cursors[cursors.length - 1] ?? "")
  const { data, failure, loading, refresh } = useInspectorResource(api.fetch, path, REFRESH_MS, isConnectionsData)
  const next = data?.next ?? null
  const onPage = useCallback((page: number) => {
    setCursors((cs) => (page < cs.length - 1 ? cs.slice(0, page + 1) : next !== null ? [...cs, next] : cs))
  }, [next])
  if (failure && data === null) return <InspectorFailureView failure={failure} mode={api.mode} onRetry={refresh} />
  if (loading || data === null) return <p className="text-sm text-muted-foreground py-6">Loading clients…</p>
  const paged = data.total > CLIENTS_PAGE_SIZE || cursors.length > 1
  return (
    <>
      <ClientsTable data={data} />
      {paged && <Pager at={{ page: cursors.length - 1, pageSize: CLIENTS_PAGE_SIZE, total: data.total }} onPage={onPage} />}
    </>
  )
}
