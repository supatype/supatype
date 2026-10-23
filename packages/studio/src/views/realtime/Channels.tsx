import React from "react"
import { Badge, TableCard, Td, Th } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { useInspectorResource } from "../../hooks/useInspectorResource.js"
import { isChannelsData } from "../../lib/realtime-guards.js"
import type { InspectorTabProps } from "./InspectorTab.js"
import { InspectorFailureView, When } from "./shared.js"
import type { ChannelSummary, ChannelsData } from "./types.js"

const REFRESH_MS = 5000

function TargetBadges({ channel }: { channel: ChannelSummary }): React.ReactElement {
  if (channel.targets.length === 0) return <span className="text-xs text-muted-foreground">broadcast and presence only</span>
  return (
    <div className="flex flex-wrap gap-1">
      {channel.targets.map((t) => (
        <Badge key={`${t.schema}.${t.table}:${t.event}`} variant="indigo" title={`${t.subscribers} subscriber(s)`}>
          {t.schema}.{t.table} {t.event}
          {t.filtered ? " (filtered)" : ""}
        </Badge>
      ))}
    </div>
  )
}

function ChannelRow({ channel }: { channel: ChannelSummary }): React.ReactElement {
  return (
    <tr className="border-b border-border hover:bg-accent/50">
      <Td className="font-mono text-xs">{channel.name}</Td>
      <Td>{channel.subscribers}</Td>
      <Td><TargetBadges channel={channel} /></Td>
      <Td>{channel.presence}</Td>
      <Td className="text-xs text-muted-foreground"><When at={channel.createdAt} /></Td>
      <Td className="text-xs text-muted-foreground"><When at={channel.lastEventAt} /></Td>
    </tr>
  )
}

/** The channels table, given what realtime reported. */
export function ChannelsTable({ data }: { data: ChannelsData }): React.ReactElement {
  return (
    <div className="space-y-3">
      {!data.service.ready && (
        <ErrorBanner message={`Realtime is not receiving database changes: ${data.service.reason ?? "replication is not connected yet"}.`} />
      )}
      {data.channels.length === 0 ? (
        <EmptyState title="No channels" description="No client is subscribed to anything right now." />
      ) : (
        <TableCard head={<><Th>Channel</Th><Th>Subscribers</Th><Th>Targets</Th><Th>Presence</Th><Th>Created</Th><Th>Last event</Th></>}>
          {data.channels.map((channel) => <ChannelRow key={channel.name} channel={channel} />)}
        </TableCard>
      )}
      {data.truncated === true && <p className="text-xs text-muted-foreground">Showing the busiest 1000 channels.</p>}
    </div>
  )
}

export function Channels({ api }: InspectorTabProps): React.ReactElement {
  const { data, failure, loading, refresh } = useInspectorResource(api.fetch, "realtime/channels", REFRESH_MS, isChannelsData)
  if (failure && data === null) return <InspectorFailureView failure={failure} mode={api.mode} onRetry={refresh} />
  if (loading || data === null) return <p className="text-sm text-muted-foreground py-6">Loading channels…</p>
  return <ChannelsTable data={data} />
}
