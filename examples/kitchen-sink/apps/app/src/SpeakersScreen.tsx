import React from "react"
import { useQuery } from "@supatype/react"
import type { Database } from "../../../supatype/generated/database"
import { Avatar, Card, EmptyState, Grid, Note, PageHeader, ProvesNote, Row, Skeleton, Stack } from "./components/ui.js"
import { localized } from "./lib/localized.js"

type Speaker = Database["public"]["Tables"]["speaker"]["Row"]

/**
 * Everyone speaking, with their headshots and bios.
 *
 * `Speaker` carries the same publishing rule as `Talk`, so an unannounced speaker is absent here
 * rather than filtered out. It is also the model whose `name` is `Searchable`, which is what gives
 * Studio a search box on the list view.
 */
export function SpeakersScreen(): React.ReactElement {
  const { data, error, loading } = useQuery<Database, "speaker", Speaker>("speaker", {
    order: { column: "name", ascending: true },
    limit: 100,
  })

  const note = (
    <ProvesNote>
      <p>
        Bios are <code>Optional&lt;Localized&lt;RichText&gt;&gt;</code>. A speaker with no English
        bio shows none rather than borrowing another language.
      </p>
      <p>
        <code>links</code> is <code>JSON&lt;&#123; label, href &#125;[]&gt;</code>: the shape
        travels with the value, because a list of two strings is not worth its own table and a
        join.
      </p>
      <p>
        Headshots live in a public bucket, so the URL on the row is enough. Compare{" "}
        <strong>My ticket</strong>, where the PDF is private and needs a signed URL.
      </p>
    </ProvesNote>
  )

  if (loading) {
    return (
      <>
        <PageHeader title="Speakers" />
        {note}
        <Skeleton rows={3} height={104} />
      </>
    )
  }
  if (error) {
    return (
      <>
        <PageHeader title="Speakers" />
        {note}
        <Note tone="error">{error.message}</Note>
      </>
    )
  }

  const speakers = data ?? []
  if (speakers.length === 0) {
    return (
      <>
        <PageHeader title="Speakers" />
        {note}
        <EmptyState title="No speakers announced">
          A speaker appears once <code>published_at</code> has passed, the same rule the programme
          uses.
        </EmptyState>
      </>
    )
  }

  return (
    <>
      <PageHeader title="Speakers" subtitle={`${speakers.length} announced.`} />
      {note}
      <Grid columns={2}>
        {speakers.map((speaker) => (
          <SpeakerCard key={speaker.id} speaker={speaker} />
        ))}
      </Grid>
    </>
  )
}

function SpeakerCard({ speaker }: { speaker: Speaker }): React.ReactElement {
  const bio = localized(speaker.bio, "en")
  const asset = speaker.headshot as { url?: string } | null
  const links = Array.isArray(speaker.links)
    ? (speaker.links as Array<{ label?: string; href?: string }>)
    : []

  return (
    <Card>
      <Stack gap={12}>
        <Row gap={12} align="top">
          <Avatar name={speaker.name} src={asset?.url ?? null} size={52} />
          <div style={{ minWidth: 0 }}>
            <div className="ks-strong">{speaker.name}</div>
            {speaker.email != null && (
              <div className="ks-faint ks-small ks-truncate">{speaker.email}</div>
            )}
          </div>
        </Row>

        {bio !== null ? (
          <p className="ks-muted ks-small ks-prose" style={{ margin: 0 }}>{bio}</p>
        ) : (
          <p className="ks-faint ks-small" style={{ margin: 0 }}>No English bio yet.</p>
        )}

        {links.length > 0 && (
          <Row gap={12} wrap>
            {links.map((link) => (
              <a key={link.href ?? link.label} className="ks-small" href={link.href ?? "#"}>
                {link.label ?? link.href}
              </a>
            ))}
          </Row>
        )}
      </Stack>
    </Card>
  )
}
