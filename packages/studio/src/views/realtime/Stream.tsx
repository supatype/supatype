import React, { useState } from "react"
import { Badge, Button, Card, CodeBlock, Input, Select } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { NO_FILTERS, useRealtimeStream, type StreamFilters, type StreamKind, type StreamState } from "../../hooks/useRealtimeStream.js"
import type { InspectorTabProps } from "./InspectorTab.js"
import { InspectorFailureView, PayloadBlock, When } from "./shared.js"
import type { PayloadView, StreamBroadcast, StreamChange, StreamRow } from "./types.js"

/** What the stream's payloads are, in words: the control plane chose the view, not the viewer. */
export const VIEW_LABEL: Record<PayloadView, string> = {
  delivered: "As each subscriber received it",
  viewer: "As you would receive it",
  redacted: "Restricted columns redacted",
  none: "Metadata only",
}

function rowKey(row: StreamRow): string {
  switch (row.kind) {
    case "change": return `c${row.change.seq}`
    case "broadcast": return `b${row.broadcast.seq}`
    case "presence": return `p${row.presence.seq}`
    case "sampled": return row.key
  }
}

function FilterBar({ filters, onChange }: { filters: StreamFilters; onChange: (next: StreamFilters) => void }): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select aria-label="Kind" value={filters.kind} onChange={(e) => onChange({ ...filters, kind: e.target.value as StreamKind })}>
        <option value="all">All kinds</option>
        <option value="change">Changes</option>
        <option value="broadcast">Broadcasts</option>
        <option value="presence">Presence</option>
      </Select>
      <Select aria-label="Event" value={filters.event} onChange={(e) => onChange({ ...filters, event: e.target.value as StreamFilters["event"] })}>
        <option value="">All events</option>
        <option value="INSERT">INSERT</option>
        <option value="UPDATE">UPDATE</option>
        <option value="DELETE">DELETE</option>
      </Select>
      <Input aria-label="Channel" className="w-44" placeholder="Channel" value={filters.channel} onChange={(e) => onChange({ ...filters, channel: e.target.value })} />
      <Input aria-label="Table" className="w-44" placeholder="Table" value={filters.table} onChange={(e) => onChange({ ...filters, table: e.target.value })} />
    </div>
  )
}

function ChangeDetail({ change }: { change: StreamChange }): React.ReactElement {
  return (
    <div className="space-y-2 pt-2">
      {change.viewer !== undefined && (
        change.viewer.visible && change.viewer.payload !== undefined
          ? <PayloadBlock sides={change.viewer.payload} redacted={change.viewer.redacted} />
          : <p className="text-xs text-muted-foreground">{change.viewer.visible ? "Too large to show." : "You could not see this row."}</p>
      )}
      {change.deliveries.map((d) => (
        <div key={`${d.connectionId}-${d.channel}`} className="space-y-1">
          <p className="text-xs text-muted-foreground">To connection {d.connectionId} on <span className="font-mono">{d.channel}</span>, {d.bytes} bytes</p>
          {d.payload !== undefined && <PayloadBlock sides={d.payload} redacted={d.redacted} />}
          {d.truncated === true && <p className="text-xs text-muted-foreground">Payload over 16 KB, not shown.</p>}
        </div>
      ))}
      {change.withheld.map((w) => (
        <p key={`${w.connectionId}-${w.channel}`} className="text-xs">
          <Badge variant={w.severity === "failed" ? "red" : "yellow"}>{w.severity}</Badge>{" "}
          withheld from connection {w.connectionId} on <span className="font-mono">{w.channel}</span>: {w.reason}
        </p>
      ))}
    </div>
  )
}

function BroadcastDetail({ broadcast }: { broadcast: StreamBroadcast }): React.ReactElement {
  if (broadcast.payload !== undefined) return <CodeBlock className="text-xs p-3 mt-2">{JSON.stringify(broadcast.payload, null, 2)}</CodeBlock>
  return <p className="text-xs text-muted-foreground pt-2">{broadcast.truncated === true ? "Payload over 16 KB, not shown." : "No payload shown in this view."}</p>
}

/** One row's summary line: what it was, where, and when. */
function SummaryLine({ badge, variant, subject, detail, at }: {
  badge: string
  variant: "blue" | "indigo" | "green" | "outline"
  subject: string
  detail: string
  at: string
}): React.ReactElement {
  return (
    <>
      <Badge variant={variant}>{badge}</Badge>
      <span className="font-mono text-xs">{subject}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
      <span className="ml-auto text-xs text-muted-foreground"><When at={at} /></span>
    </>
  )
}

function RowSummary({ row }: { row: StreamRow }): React.ReactElement {
  switch (row.kind) {
    case "change": {
      const c = row.change
      const detail = `${c.deliveries.length} delivered, ${c.withheld.length} withheld, ${c.notMatched} not matched`
      return <SummaryLine badge={c.event} variant="blue" subject={`${c.schema}.${c.table}`} detail={detail} at={c.at} />
    }
    case "broadcast": {
      const b = row.broadcast
      const studio = b.origin === "studio"
      const detail = `${b.event}: ${b.recipients} recipient(s), ${b.bytes} bytes`
      return <SummaryLine badge={studio ? "test broadcast" : "broadcast"} variant={studio ? "indigo" : "green"} subject={b.channel} detail={detail} at={b.at} />
    }
    case "presence": {
      const p = row.presence
      return <SummaryLine badge={p.kind} variant="outline" subject={p.userId} detail={`on ${p.channel}`} at={p.at} />
    }
    case "sampled":
      return <span className="text-xs text-muted-foreground">{row.skipped} events skipped to keep to the stream's rate</span>
  }
}

function StreamRowCard({ row }: { row: StreamRow }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const expandable = row.kind === "change" || row.kind === "broadcast"
  return (
    <Card className="px-3 py-2">
      <button type="button" className="flex w-full items-center gap-2 text-left" disabled={!expandable} onClick={() => setOpen((v) => !v)} aria-expanded={expandable ? open : undefined}>
        <RowSummary row={row} />
      </button>
      {open && row.kind === "change" && <ChangeDetail change={row.change} />}
      {open && row.kind === "broadcast" && <BroadcastDetail broadcast={row.broadcast} />}
    </Card>
  )
}

/** The stream as it stands: its view, its state, and its rows. */
export function StreamRows({ state }: { state: StreamState }): React.ReactElement {
  if (state.rows.length === 0) {
    return <EmptyState title="Waiting for events" description="Changes, broadcasts and presence events appear here as realtime sends them. Nothing is stored: the stream starts when you open it." />
  }
  return (
    <div className="space-y-2">
      {state.rows.map((row) => <StreamRowCard key={rowKey(row)} row={row} />)}
    </div>
  )
}

function StreamStatus({ state }: { state: StreamState }): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      {state.ready !== null && <Badge variant="indigo">{VIEW_LABEL[state.ready.view]}</Badge>}
      <span className="text-xs text-muted-foreground">{state.status}</span>
    </div>
  )
}

export function Stream({ api }: InspectorTabProps): React.ReactElement {
  const [filters, setFilters] = useState<StreamFilters>(NO_FILTERS)
  const { state, paused, setPaused, clear, reconnect } = useRealtimeStream(api.fetch, filters)
  const failed = state.status === "error"
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FilterBar filters={filters} onChange={setFilters} />
        <div className="flex items-center gap-2">
          <StreamStatus state={state} />
          <Button onClick={() => setPaused(!paused)}>{paused ? "Resume" : "Pause"}</Button>
          <Button onClick={clear}>Clear</Button>
        </div>
      </div>
      {failed && state.errorCode === "realtime_disabled" && (
        <InspectorFailureView failure={{ status: 501, code: state.errorCode, message: state.error ?? "" }} mode={api.mode} onRetry={reconnect} />
      )}
      {failed && state.errorCode !== "realtime_disabled" && <ErrorBanner message={state.error ?? "The stream failed"} onRetry={reconnect} />}
      <StreamRows state={state} />
    </div>
  )
}
