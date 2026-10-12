/**
 * The Realtime Inspector: which channels exist, who is connected, what flows and to whom, and a
 * broadcast tester. One view for Cloud and self-host; only where the control plane is differs
 * (`usePlatformApi`). Phase-08 Appendix A.
 *
 * The route shows the Inspector only once this deployment's control plane answers for it
 * (`useInspectorAvailability`), and "coming soon" otherwise.
 */

import React from "react"
import { Navigate, useParams } from "react-router-dom"
import { EmptyState } from "../components/EmptyState.js"
import { useInspectorAvailability } from "../hooks/useInspectorAvailability.js"
import { ComingSoon } from "./ComingSoon.js"
import { Broadcast } from "./realtime/Broadcast.js"
import { Channels } from "./realtime/Channels.js"
import { Clients } from "./realtime/Clients.js"
import { Stream } from "./realtime/Stream.js"
import type { InspectorApi } from "./realtime/InspectorTab.js"

const TABS: Record<string, (props: { api: InspectorApi }) => React.ReactElement> = {
  channels: Channels,
  clients: Clients,
  stream: Stream,
  broadcast: Broadcast,
}

export const REALTIME_COMING_SOON =
  "Active channels, connected clients, a live message stream and a broadcast tester, with realtime settings to follow. The Realtime Inspector is coming soon."

/** The tab the route names, given where the project's control plane is. */
export function InspectorTabs({ api }: { api: InspectorApi }): React.ReactElement {
  const { tab } = useParams()
  const Tab = tab === undefined ? undefined : TABS[tab]
  if (Tab === undefined) return <Navigate to="/realtime/channels" replace />
  return (
    <div className="p-4 md:p-6">
      <Tab api={api} />
    </div>
  )
}

export function RealtimeInspector({ demoMode = false }: { demoMode?: boolean }): React.ReactElement {
  const { availability, api } = useInspectorAvailability({ demoMode })

  if (availability === "checking") return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (availability === "forbidden") {
    return (
      <EmptyState
        title="The Realtime Inspector is not available to your role"
        description="Studio admins and developers can inspect realtime. Ask an admin for access."
      />
    )
  }
  if (availability === "coming-soon" || api.state !== "ready") {
    return <ComingSoon title="Realtime Inspector" description={REALTIME_COMING_SOON} />
  }
  return <InspectorTabs api={{ mode: api.mode, fetch: api.fetch }} />
}
