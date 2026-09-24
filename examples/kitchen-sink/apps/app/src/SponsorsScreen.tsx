import React from "react"
import { useQuery } from "@supatype/react"
import type { Database } from "../../../supatype/generated/database"
import { Badge, Card, EmptyState, Grid, Note, PageHeader, ProvesNote, Row, Skeleton, Stack } from "./components/ui.js"
import { localized } from "./lib/localized.js"

type Sponsor = Database["public"]["Tables"]["sponsor"]["Row"]

const TIER_ORDER: Record<string, number> = { platinum: 0, gold: 1, community: 2 }

/**
 * The sponsors, grouped by tier.
 *
 * This model existed in the schema and was rendered nowhere, which is how `Color`, the tier union
 * and `Localized<Markdown>` were all declared and never seen. A sponsor's `brandColor` is theirs
 * rather than the conference's, so it is used as an accent on their own card and nowhere else.
 */
export function SponsorsScreen(): React.ReactElement {
  const { data, error, loading } = useQuery<Database, "sponsor", Sponsor>("sponsor", { limit: 100 })

  const note = (
    <ProvesNote>
      <p>
        <code>tier</code> is a union of three string literals, so the database has a CHECK and the
        generated type has a union. A fourth tier is a schema change, not a typo somebody made in a
        form.
      </p>
      <p>
        <code>brandColor</code> is <code>Color</code>, and <code>blurb</code> is{" "}
        <code>Localized&lt;Markdown&gt;</code> — rendered as text here rather than parsed, because
        an example that ships a Markdown renderer is teaching that instead.
      </p>
      <p>
        Sponsors carry the same <code>published_at</code> read rule as talks and speakers.
      </p>
    </ProvesNote>
  )

  if (loading) {
    return (
      <>
        <PageHeader title="Sponsors" />
        {note}
        <Skeleton rows={2} height={96} />
      </>
    )
  }
  if (error) {
    return (
      <>
        <PageHeader title="Sponsors" />
        {note}
        <Note tone="error">{error.message}</Note>
      </>
    )
  }

  const sponsors = [...(data ?? [])].sort(
    (a, b) => (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9),
  )

  if (sponsors.length === 0) {
    return (
      <>
        <PageHeader title="Sponsors" />
        {note}
        <EmptyState title="No sponsors published">
          A sponsor becomes readable once <code>published_at</code> has passed.
        </EmptyState>
      </>
    )
  }

  return (
    <>
      <PageHeader title="Sponsors" subtitle="The people paying for the coffee." />
      {note}
      <Grid columns={2}>
        {sponsors.map((sponsor) => (
          <SponsorCard key={sponsor.id} sponsor={sponsor} />
        ))}
      </Grid>
    </>
  )
}

function SponsorCard({ sponsor }: { sponsor: Sponsor }): React.ReactElement {
  const blurb = localized(sponsor.blurb, "en")
  const colour = typeof sponsor.brandColor === "string" ? sponsor.brandColor : null

  return (
    <Card padded={false}>
      {/* The sponsor's own colour, as a rule they own rather than one the app invents. */}
      <div style={{ height: 4, background: colour ?? "var(--ks-line)" }} aria-hidden="true" />
      <div className="ks-card__pad">
        <Stack gap={10}>
          <Row gap={10} wrap>
            <span className="ks-strong">{sponsor.name}</span>
            <Badge tone={sponsor.tier === "platinum" ? "accent" : "neutral"}>{sponsor.tier}</Badge>
          </Row>
          {blurb !== null && (
            <p className="ks-muted ks-small ks-prose" style={{ margin: 0 }}>{blurb}</p>
          )}
          {sponsor.website != null && (
            <a className="ks-small ks-truncate" href={sponsor.website}>
              {sponsor.website}
            </a>
          )}
        </Stack>
      </div>
    </Card>
  )
}
