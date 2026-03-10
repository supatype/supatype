import React, { useState, useEffect } from "react"
import { Header } from "../components/Header.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import type { DashboardWidget, ModelConfig } from "../config.js"

export function Dashboard(): React.ReactElement {
  const config = useAdminConfig()
  const widgets = config.dashboard?.widgets ?? generateDefaultWidgets(config.models)

  return (
    <div className="st-dashboard">
      <Header title="Dashboard" />
      <div className="st-dashboard-grid">
        {widgets.map((widget, i) => (
          <DashboardWidgetCard key={`${widget.type}-${i}`} widget={widget} />
        ))}
      </div>
    </div>
  )
}

function DashboardWidgetCard({ widget }: { widget: DashboardWidget }): React.ReactElement {
  switch (widget.type) {
    case "stats":
      return <StatsWidget widget={widget} />
    case "recent":
      return <RecentWidget widget={widget} />
    default:
      return (
        <div className="st-dashboard-card">
          <h3>{widget.title}</h3>
          <p>Widget type "{widget.type}" — coming soon</p>
        </div>
      )
  }
}

function StatsWidget({ widget }: { widget: DashboardWidget }): React.ReactElement {
  const client = useAdminClient()
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    if (!widget.model) return
    void (async () => {
      try {
        const result = await client
          .from(widget.model as never)
          .select("*")
        setCount(Array.isArray(result.data) ? result.data.length : 0)
      } catch {
        setCount(0)
      }
    })()
  }, [client, widget.model])

  return (
    <div className="st-dashboard-card st-dashboard-card--stats">
      <h3 className="st-dashboard-card-title">{widget.title}</h3>
      <div className="st-dashboard-stat">{count ?? "..."}</div>
    </div>
  )
}

function RecentWidget({ widget }: { widget: DashboardWidget }): React.ReactElement {
  const client = useAdminClient()
  const [items, setItems] = useState<Record<string, unknown>[]>([])

  useEffect(() => {
    if (!widget.model) return
    void (async () => {
      try {
        const result = await client
          .from(widget.model as never)
          .select()
          .order("created_at", { ascending: false })
          .limit(5)

        if (result.data) {
          setItems(result.data as Record<string, unknown>[])
        }
      } catch {
        setItems([])
      }
    })()
  }, [client, widget.model])

  return (
    <div className="st-dashboard-card st-dashboard-card--recent">
      <h3 className="st-dashboard-card-title">{widget.title}</h3>
      <ul className="st-dashboard-recent-list">
        {items.map((item, i) => (
          <li key={i} className="st-dashboard-recent-item">
            {String(item["name"] ?? item["title"] ?? item["id"] ?? `Item ${i + 1}`)}
          </li>
        ))}
        {items.length === 0 && <li className="st-dashboard-recent-empty">No items yet</li>}
      </ul>
    </div>
  )
}

function generateDefaultWidgets(models: ModelConfig[]): DashboardWidget[] {
  return models.slice(0, 4).flatMap((m) => [
    { type: "stats" as const, title: `Total ${m.labelPlural}`, model: m.tableName },
    { type: "recent" as const, title: `Recent ${m.labelPlural}`, model: m.tableName },
  ])
}
