import React from "react"
import { useQuery } from "@supatype/react"
import type { Database } from "../../../supatype/generated/database"

type Talk = Database["public"]["Tables"]["talk"]["Row"]

/**
 * The published schedule.
 *
 * No `.eq("published_at", …)` anywhere: `Talk`'s read rule is `Lte<"published_at", Now>`, so an
 * unpublished talk is unreadable rather than merely unselected. The filter every query would
 * otherwise have to remember is a property of the model instead.
 */
export function ScheduleScreen(): React.ReactElement {
  const { data, error, loading } = useQuery<Database, "talk", Talk>("talk", {
    order: { column: "starts_at", ascending: true },
    limit: 50,
  })

  if (loading) return <p className="ks-muted">Loading the schedule…</p>
  if (error) return <p className="ks-error">{error.message}</p>
  if (!data || data.length === 0) {
    return (
      <p className="ks-muted">
        Nothing published yet. Publish a talk in Studio and it appears here — the row becomes
        readable at the moment <code>published_at</code> passes, with no cron and no publish worker.
      </p>
    )
  }

  return (
    <ul className="ks-list">
      {data.map((talk) => (
        <li key={talk.id} className="ks-card">
          <h3>{talk.title}</h3>
          <p className="ks-muted">
            {new Date(talk.starts_at).toLocaleString("en-GB", {
              weekday: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </li>
      ))}
    </ul>
  )
}
