import { sql } from "@supatype/cli/seed"

/**
 * Enough of a conference for both front ends to have something to show.
 *
 * Seeds run as direct SQL, which is the interesting part rather than an aside: every rule in
 * `schema/index.ts` that compiles to a `CHECK` or a `CONSTRAINT` applies here — a talk whose
 * `starts_at` is after its `ends_at` is refused by Postgres, at this line, with no API in the way.
 * The rules that do *not* apply are the ones the API enforces: access rules and the per-field
 * validator. That asymmetry is the whole reason `constraints` exist alongside `validate`.
 *
 * `published_at` is written directly here. Through the API it is `supatype.publish`'s to set and
 * nothing else's; a seed is not going through the API, and a fixture nobody can read is not a
 * fixture. Seeding published rows is how both apps have anything to render on first run.
 */
const db = sql(
  process.env["DATABASE_URL"] ??
    "postgresql://supatype_admin:postgres@localhost:5432/kitchen-sink",
)

const HERO = {
  type: "hero",
  heading: "Kitchen Sink Conference",
  subheading: "One schema, two front ends, every feature that ships.",
  cta: { label: "See the talks", href: "/talks", target: "_self" },
}

const PROSE = {
  type: "prose",
  body: "Two days of people explaining how their database is laid out. Catering is adequate.",
}

const SPEAKER_GRID = { type: "speakerGrid", heading: "Speaking", limit: 6 }

async function seed(): Promise<void> {
  console.log("Seeding kitchen-sink…")

  await db`
    INSERT INTO page (title, slug, summary, body, published_at)
    VALUES (
      'Kitchen Sink Conference',
      'home',
      'One schema, two front ends, every feature that ships.',
      ${JSON.stringify([HERO, PROSE, SPEAKER_GRID])}::jsonb,
      NOW()
    )
    ON CONFLICT (slug) DO NOTHING
  `

  // `db` answers with a pg QueryResult, so the inserted row is in `.rows` rather than the result
  // itself. Spelled out here because a seed that reads `result[0]` gets `undefined` and inserts a
  // null foreign key without complaining.
  const hall = (await db`
    INSERT INTO room (name, capacity)
    VALUES ('Main Hall', 400)
    RETURNING id
  `).rows[0] as { id: string }

  const speaker = (await db`
    INSERT INTO speaker (name, slug, email, published_at)
    VALUES ('Ada Buckley', 'ada-buckley', 'ada@example.com', NOW())
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `).rows[0] as { id: string }

  // One published talk and one still in draft: the pair is what makes the read rule visible. Both
  // rows exist; only the first is readable by anyone who is not its editor.
  await db`
    INSERT INTO talk (title, slug, speaker_id, room_id, day, starts_at, ends_at, length, published_at)
    VALUES (
      'Schemas that refuse bad data',
      'schemas-that-refuse-bad-data',
      ${speaker.id}, ${hall.id},
      CURRENT_DATE, NOW() + INTERVAL '1 hour', NOW() + INTERVAL '2 hours',
      ${JSON.stringify({ ms: 3_600_000 })}::jsonb,
      NOW()
    )
    ON CONFLICT (slug) DO NOTHING
  `

  await db`
    INSERT INTO talk (title, slug, speaker_id, room_id, day, starts_at, ends_at, length)
    VALUES (
      'Unfinished thoughts on indexes',
      'unfinished-thoughts-on-indexes',
      ${speaker.id}, ${hall.id},
      CURRENT_DATE, NOW() + INTERVAL '3 hours', NOW() + INTERVAL '4 hours',
      ${JSON.stringify({ ms: 3_600_000 })}::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
  `

  await db`
    INSERT INTO sponsor (name, tier, "brandColor", website, published_at)
    VALUES ('Northwind Databases', 'gold', '#00684a', 'https://example.com', NOW())
    ON CONFLICT DO NOTHING
  `

  await db.end()
  console.log("Done. One page, one room, one speaker, two talks (one published), one sponsor.")
}

seed().catch((e) => {
  console.error(e)
  process.exit(1)
})
