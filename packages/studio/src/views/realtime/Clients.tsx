import React from "react"
import { Badge, Card, Td, Th } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { useInspectorResource } from "../../hooks/useInspectorResource.js"
import type { InspectorTabProps } from "./InspectorTab.js"
import { InspectorFailureView, When } from "./shared.js"
import type { ConnectionSummary, ConnectionsData } from "./types.js"

const REFRESH_MS = 5000

/** "12 of 500 connections" against a limit; just the count when there is none (self-host). */
export function connectionCount(data: Pick<ConnectionsData, "total" | "limit">): string {
  const noun = data.total === 1 ? "connection" : "connections"
  return data.limit === null ? `${data.total} ${noun}` : `${data.total} of ${data.limit} ${noun}`
}

function ClientRow({ connection }: { connection: ConnectionSummary }): React.ReactElement {
  const client = connection.client
  return (
    <tr className="border-b border-border hover:bg-accent/50">
      <Td className="font-mono text-xs">{connection.userId ?? <span className="text-muted-foreground">not signed in</span>}</Td>
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
        <Card className="overflow-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <Th>User</Th>
                <Th>Role</Th>
                <Th>Connected</Th>
                <Th>Last message</Th>
                <Th>Channels</Th>
                <Th>Client</Th>
              </tr>
            </thead>
            <tbody>
              {data.connections.map((c) => <ClientRow key={c.id} connection={c} />)}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}

export function Clients({ api }: InspectorTabProps): React.ReactElement {
  const { data, failure, loading, refresh } = useInspectorResource<ConnectionsData>(api.fetch, "realtime/connections?limit=100", REFRESH_MS)
  if (failure && data === null) return <InspectorFailureView failure={failure} mode={api.mode} onRetry={refresh} />
  if (loading || data === null) return <p className="text-sm text-muted-foreground py-6">Loading clients…</p>
  return <ClientsTable data={data} />
}
