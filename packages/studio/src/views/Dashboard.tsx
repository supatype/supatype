import React, { useState, useEffect } from "react"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import type { DashboardWidget, ModelConfig } from "../config.js"

export function Dashboard(): React.ReactElement {
  const config = useAdminConfig()
  const widgets = config.dashboard?.widgets ?? generateDefaultWidgets(config.models)

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {widgets.map((widget, i) => (
          <DashboardWidgetCard key={`${widget.type}-${i}`} widget={widget} />
        ))}
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
        <div className="rounded-lg border border-border bg-card p-5">
          <h3 className="text-sm font-semibold text-foreground mb-3">{widget.title}</h3>
          <p className="text-sm text-muted-foreground">Widget type &ldquo;{widget.type}&rdquo; — coming soon</p>
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
    <div className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">{widget.title}</h3>
      <div className="text-3xl font-bold text-foreground">{count ?? "\u2026"}</div>
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
    <div className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">{widget.title}</h3>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="py-1.5 border-b border-border last:border-0 text-sm text-foreground">
            {String(item["name"] ?? item["title"] ?? item["id"] ?? `Item ${i + 1}`)}
          </li>
        ))}
        {items.length === 0 && <li className="text-sm text-muted-foreground">No items yet</li>}
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
