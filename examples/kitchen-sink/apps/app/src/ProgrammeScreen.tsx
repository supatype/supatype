import React from "react"
import { useQuery } from "@supatype/react"
import type { Database } from "../../../supatype/generated/database"
import { Avatar, Badge, EmptyState, PageHeader, ProvesNote, Row, Skeleton, Note } from "./components/ui.js"
import { localized } from "./lib/localized.js"

type Talk = Database["public"]["Tables"]["talk"]["Row"]
type Speaker = Database["public"]["Tables"]["speaker"]["Row"]
type Room = Database["public"]["Tables"]["room"]["Row"]

/**
 * The published programme, grouped by day.
 *
 * There is no `.eq("published_at", …)` anywhere. `Talk`'s read rule is `Lte<"published_at", Now>`,
 * so an unpublished talk is unreadable rather than merely unselected: the filter every query would
 * otherwise have to remember is a property of the model instead. A draft talk is absent from this
 * list for the same reason it is absent from the marketing site, with no code in common.
 *
 * Speakers and rooms are fetched alongside and joined in memory rather than through an embedded
 * select, because each is a small, cacheable, independently-declared table: `Speaker` and `Room`
 * both declare `cache: { rows: true }`, so those two reads come from the row cache on a warm
 * server while the talk list does not.
 */
export function ProgrammeScreen(): React.ReactElement {
  const talks = useQuery<Database, "talk", Talk>("talk", {
    order: { column: "starts_at", ascending: true },
    limit: 100,
  })
  const speakers = useQuery<Database, "speaker", Speaker>("speaker", { limit: 100 })
  const rooms = useQuery<Database, "room", Room>("room", { limit: 50 })

  const speakerById = new Map((speakers.data ?? []).map((s) => [s.id, s]))
  const roomById = new Map((rooms.data ?? []).map((r) => [r.id, r]))

  const note = (
    <ProvesNote>
      <p>
        The list is unfiltered. <code>Talk</code> is read-gated on{" "}
        <code>Lte&lt;&quot;published_at&quot;, Now&gt;</code>, so a draft is unreadable rather than
        excluded by a <code>where</code> clause this screen had to remember.
      </p>
      <p>
        Abstracts are <code>Localized&lt;RichText&gt;</code>: the API returns every language at
        once and the client picks one. A talk with no French abstract renders as absent in French
        rather than falling back to English, because a fallback tells a reader a translation exists.
      </p>
      <p>
        Speaker headshots come from <code>speaker-headshots</code>, a public bucket, transformed on
        read rather than at upload.
      </p>
    </ProvesNote>
  )

  if (talks.loading) {
    return (
      <>
        <PageHeader title="Programme" subtitle="Every published talk, by day." />
        {note}
        <Skeleton rows={4} height={78} />
      </>
    )
  }

  if (talks.error) {
    return (
      <>
        <PageHeader title="Programme" />
        {note}
        <Note tone="error">{talks.error.message}</Note>
      </>
    )
  }

  const published = talks.data ?? []

  if (published.length === 0) {
    return (
      <>
        <PageHeader title="Programme" />
        {note}
        <EmptyState title="Nothing published yet">
          Publish a talk in Studio and it appears here. The row becomes readable the moment{" "}
          <code>published_at</code> passes, with no cron and no publish worker.
        </EmptyState>
      </>
    )
  }

  const byDay = new Map<string, Talk[]>()
  for (const talk of published) {
    const day = talk.day ?? talk.starts_at.slice(0, 10)
    const list = byDay.get(day)
    if (list) list.push(talk)
    else byDay.set(day, [talk])
  }

  return (
    <>
      <PageHeader
        title="Programme"
        subtitle={`${published.length} talk${published.length === 1 ? "" : "s"} across ${byDay.size} day${byDay.size === 1 ? "" : "s"}.`}
      />
      {note}

      {[...byDay.entries()].map(([day, dayTalks]) => (
        <section className="ks-day" key={day}>
          <h2 className="ks-day__label">{formatDay(day)}</h2>
          {dayTalks.map((talk) => (
            <Slot
              key={talk.id}
              talk={talk}
              speaker={talk.speaker_id != null ? speakerById.get(talk.speaker_id) : undefined}
              room={talk.room_id != null ? roomById.get(talk.room_id) : undefined}
            />
          ))}
        </section>
      ))}
    </>
  )
}

function Slot({
  talk,
  speaker,
  room,
}: {
  talk: Talk
  speaker: Speaker | undefined
  room: Room | undefined
}): React.ReactElement {
  const abstract = localized(talk.abstract, "en")
  return (
    <article className="ks-slot">
      <div className="ks-slot__time">
        {formatTime(talk.starts_at)}
        <span className="ks-slot__dur">{formatDuration(talk.length)}</span>
      </div>
      <div className="ks-slot__main">
        <h3 className="ks-slot__title">{talk.title}</h3>
        {abstract !== null && <p className="ks-muted ks-small ks-prose">{abstract}</p>}
        <div className="ks-slot__meta">
          {speaker && (
            <Row gap={7}>
              <Avatar name={speaker.name} src={headshotUrl(speaker)} size={24} />
              <span className="ks-small">{speaker.name}</span>
            </Row>
          )}
          {room && (
            <Badge>
              {room.name}
              {room.capacity != null ? ` · ${room.capacity} seats` : ""}
            </Badge>
          )}
        </div>
      </div>
    </article>
  )
}

/**
 * A public bucket's object is reachable by URL alone, which is what `accessMode: "public"` means.
 * The reference the column carries already holds that URL, so there is nothing to sign.
 */
function headshotUrl(speaker: Speaker): string | null {
  const asset = speaker.headshot as { url?: string } | null
  return typeof asset?.url === "string" && asset.url !== "" ? asset.url : null
}

function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00`)
  if (Number.isNaN(date.getTime())) return day
  return date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })
}

function formatTime(at: string): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
}

/** `Duration` crosses the wire as `{ ms }` rather than a number, so it cannot be printed raw. */
function formatDuration(value: unknown): string {
  const ms = (value as { ms?: number } | null)?.ms
  if (typeof ms !== "number" || ms <= 0) return ""
  const minutes = Math.round(ms / 60_000)
  return minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10}h` : `${minutes} min`
}
