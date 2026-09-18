import React from "react"
import { createClient } from "@/lib/supatype-server"
import type { Database } from "../../../../supatype/generated/database"

type Talk = Database["public"]["Tables"]["talk"]["Row"]

export default async function TalksPage(): Promise<React.ReactElement> {
  const supatype = await createClient()
  const { data, error } = await supatype
    .from("talk")
    .select()
    .order("starts_at", { ascending: true })
    .limit(50)

  if (error !== null) return <p className="ks-error">Error: {error.message}</p>

  const talks = (data as Talk[] | null) ?? []
  if (talks.length === 0) return <p className="ks-muted">No talks published yet.</p>

  return (
    <section>
      <h1>Talks</h1>
      <ul className="ks-talks">
        {talks.map((talk) => (
          <li key={talk.id}>
            <h2>{talk.title}</h2>
            <p className="ks-muted">
              {new Date(talk.starts_at).toLocaleString("en-GB", {
                weekday: "long",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}
