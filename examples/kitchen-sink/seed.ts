import { sql } from "@supatype/cli/seed"

/**
 * Enough of a conference for both front ends to have something to show.
 *
 * Seeds run as direct SQL, which is the interesting part rather than an aside: every rule in
 * `schema/index.ts` that compiles to a `CHECK` or a `CONSTRAINT` applies here, so a talk whose
 * `starts_at` is after its `ends_at` is refused by Postgres, at that line, with no API in the way.
 * The rules that do *not* apply are the ones the API enforces: access rules and the per-field
 * validator. That asymmetry is the whole reason `constraints` exist alongside `validate`.
 *
 * `published_at` is written directly here. Through the API it is `supatype.publish`'s to set and
 * nothing else's; a seed is not going through the API, and a fixture nobody can read is not a
 * fixture.
 *
 * Talks upsert rather than skipping on conflict. `DO NOTHING` meant a re-seed kept whatever was
 * already there, so changing a time or adding an abstract had no effect and the programme showed a
 * row from an older fixture sitting at an odd time with no abstract, next to rows from the current
 * one. A seed that cannot converge is a fixture you have to drop the database to change.
 *
 * Deliberately more than the minimum. One talk and one speaker made every list in the app look
 * like a defect: a programme with a single row cannot show grouping by day, a speaker grid cannot
 * show a grid, and an empty sponsors screen is indistinguishable from a broken query. Two days,
 * three rooms, five speakers and eight talks is the smallest fixture where the layouts mean
 * anything, and one unpublished talk is what keeps the read rule visible.
 */

/**
 * `DATABASE_URL` from `.env`, which `pnpm seed` loads with `--env-file-if-exists`.
 *
 * Nothing loaded it before, so this always fell through to a hardcoded guess, and the guess named
 * a port and a database this stack does not use. The failure is `ECONNREFUSED` against a port
 * nothing is listening on, which says nothing about where the real one is. The compose db
 * publishes 5432 and the database is named for the project, both of which `.env` already records
 * correctly, so the fix is to read it rather than to guess better.
 */
const db = sql(
  process.env["DATABASE_URL"] ??
    `postgresql://${process.env["POSTGRES_USER"] ?? "supatype_admin"}:${
      process.env["POSTGRES_PASSWORD"] ?? "postgres"
    }@127.0.0.1:5432/${process.env["POSTGRES_DB"] ?? "kitchen-sink"}?sslmode=disable`,
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

/** Both conference days, relative to today so the fixture never goes stale. */
const DAY_ONE = new Date()
const DAY_TWO = new Date(Date.now() + 24 * 60 * 60 * 1000)

function isoDay(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/** A timestamp on a given day, so the programme groups rather than running past midnight. */
function at(day: Date, hour: number, minute = 0): string {
  const d = new Date(day)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}

const SPEAKERS = [
  {
    slug: "ada-buckley",
    name: "Ada Buckley",
    email: "ada@example.com",
    bio: {
      en: "Spends her days explaining to application servers that the database was right.",
      fr: "Passe ses journées à expliquer aux serveurs que la base de données avait raison.",
    },
    links: [{ label: "Website", href: "https://example.com/ada" }],
  },
  {
    slug: "rune-oyelaran",
    name: "Rune Oyelaran",
    email: "rune@example.com",
    // No French bio on purpose: the app must render that as absent rather than falling back.
    bio: { en: "Builds migration tools, mostly so he never has to run one by hand again." },
    links: [{ label: "Notes", href: "https://example.com/rune" }],
  },
  {
    slug: "mira-halvorsen",
    name: "Mira Halvorsen",
    email: "mira@example.com",
    bio: { en: "Has opinions about row-level security and will share them unprompted." },
    links: [],
  },
  {
    slug: "tomasz-leclerc",
    name: "Tomasz Leclerc",
    email: "tomasz@example.com",
    bio: { en: "Once dropped a production index on a Friday and lived to give this talk." },
    links: [{ label: "Blog", href: "https://example.com/tomasz" }],
  },
  {
    slug: "priya-raman",
    name: "Priya Raman",
    email: "priya@example.com",
    bio: { en: "Works on caching, and on convincing people they do not need any." },
    links: [],
  },
] as const

/** `[slug, title, speaker, room, day, hour, minutes, published]` */
const TALKS: Array<[string, string, string, string, Date, number, number, boolean]> = [
  ["schemas-that-refuse-bad-data", "Schemas that refuse bad data", "ada-buckley", "Main Hall", DAY_ONE, 9, 45, true],
  ["migrations-without-the-maintenance-window", "Migrations without the maintenance window", "rune-oyelaran", "Main Hall", DAY_ONE, 11, 60, true],
  ["row-level-security-in-anger", "Row-level security, in anger", "mira-halvorsen", "Side Room", DAY_ONE, 13, 30, true],
  ["the-index-you-did-not-need", "The index you did not need", "tomasz-leclerc", "Side Room", DAY_ONE, 14, 45, true],
  ["caching-is-a-correctness-problem", "Caching is a correctness problem", "priya-raman", "Main Hall", DAY_ONE, 16, 45, true],
  ["types-all-the-way-down", "Types all the way down", "ada-buckley", "Main Hall", DAY_TWO, 10, 60, true],
  ["realtime-without-a-message-broker", "Realtime without a message broker", "rune-oyelaran", "Workshop Room", DAY_TWO, 12, 45, true],
  // Unpublished on purpose: the pair is what makes the read rule visible in both front ends.
  ["unfinished-thoughts-on-indexes", "Unfinished thoughts on indexes", "tomasz-leclerc", "Workshop Room", DAY_TWO, 15, 45, false],
]

const SPONSORS = [
  ["Northwind Databases", "platinum", "#00684a", "https://example.com/northwind", "Managed Postgres for people who would rather not."],
  ["Tessellate Cloud", "gold", "#3b5bdb", "https://example.com/tessellate", "Regions you have heard of, and three you have not."],
  ["Cadence Analytics", "gold", "#b5179e", "https://example.com/cadence", "Dashboards nobody asked for, delivered daily."],
  ["The Local Coffee Co-op", "community", "#8a5a2b", "https://example.com/coffee", "Responsible for the only queue at this event."],
] as const

async function seed(): Promise<void> {
  console.log("Seeding kitchen-sink…")

  // The singleton an editor owns in Studio, and what the app puts in its title bar. Its table is
  // named for the global rather than the model, which is what `singleton: true` does.
  await db`
    INSERT INTO _global_site_settings (id, "conferenceName", tagline, "supportEmail")
    SELECT
      gen_random_uuid(),
      'Kitchen Sink Conference',
      ${JSON.stringify({ en: "Two days of people explaining their schemas", fr: "Deux jours d'explications de schémas" })}::jsonb,
      'hello@example.com'
    WHERE NOT EXISTS (SELECT 1 FROM _global_site_settings)
  `

  // `title` is `Localized<string>`, so the column is jsonb holding every language at once, not
  // text. A bare string is refused by Postgres as invalid JSON rather than stored as a one-locale
  // value, which is the right answer: a localized column with no locale key is unreadable by
  // anything that asks for a language. `summary` is not localized and stays text.
  await db`
    INSERT INTO page (title, slug, summary, body, published_at)
    VALUES (
      ${JSON.stringify({ en: "Kitchen Sink Conference", fr: "La conférence évier de cuisine" })}::jsonb,
      'home',
      'One schema, two front ends, every feature that ships.',
      ${JSON.stringify([HERO, PROSE, SPEAKER_GRID])}::jsonb,
      NOW()
    )
    ON CONFLICT (slug) DO NOTHING
  `

  const rooms = new Map<string, string>()
  for (const [name, capacity] of [["Main Hall", 400], ["Side Room", 120], ["Workshop Room", 40]] as const) {
    // `db` answers with a pg QueryResult, so the inserted row is in `.rows` rather than the result
    // itself. Spelled out because a seed that reads `result[0]` gets `undefined` and inserts a null
    // foreign key without complaining.
    const existing = (await db`SELECT id FROM room WHERE name = ${name}`).rows[0] as
      | { id: string }
      | undefined
    if (existing) {
      rooms.set(name, existing.id)
      continue
    }
    const created = (await db`
      INSERT INTO room (name, capacity) VALUES (${name}, ${capacity}) RETURNING id
    `).rows[0] as { id: string }
    rooms.set(name, created.id)
  }

  const speakers = new Map<string, string>()
  for (const person of SPEAKERS) {
    const row = (await db`
      INSERT INTO speaker (name, slug, bio, links, email, published_at)
      VALUES (
        ${person.name}, ${person.slug},
        ${JSON.stringify(person.bio)}::jsonb,
        ${JSON.stringify(person.links)}::jsonb,
        ${person.email}, NOW()
      )
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        bio = EXCLUDED.bio,
        links = EXCLUDED.links,
        email = EXCLUDED.email,
        published_at = EXCLUDED.published_at
      RETURNING id
    `).rows[0] as { id: string }
    speakers.set(person.slug, row.id)
  }

  for (const [slug, title, speakerSlug, roomName, day, hour, minutes, published] of TALKS) {
    await db`
      INSERT INTO talk (title, slug, speaker_id, room_id, day, starts_at, ends_at, length, abstract, published_at)
      VALUES (
        ${title}, ${slug},
        ${speakers.get(speakerSlug)!}, ${rooms.get(roomName)!},
        ${isoDay(day)}::date,
        ${at(day, hour)}::timestamptz,
        ${at(day, hour, minutes)}::timestamptz,
        ${JSON.stringify({ ms: minutes * 60_000 })}::jsonb,
        ${JSON.stringify({ en: `A talk in the ${roomName.toLowerCase()}, and the abstract an editor would have written.` })}::jsonb,
        ${published ? new Date().toISOString() : null}
      )
      ON CONFLICT (slug) DO UPDATE SET
        title = EXCLUDED.title,
        speaker_id = EXCLUDED.speaker_id,
        room_id = EXCLUDED.room_id,
        day = EXCLUDED.day,
        starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at,
        length = EXCLUDED.length,
        abstract = EXCLUDED.abstract,
        published_at = EXCLUDED.published_at
    `
  }

  for (const [name, tier, brandColor, website, blurb] of SPONSORS) {
    await db`
      INSERT INTO sponsor (name, tier, "brandColor", website, blurb, published_at)
      VALUES (
        ${name}, ${tier}, ${brandColor}, ${website},
        ${JSON.stringify({ en: blurb })}::jsonb,
        NOW()
      )
      ON CONFLICT (name) DO UPDATE SET
        tier = EXCLUDED.tier,
        "brandColor" = EXCLUDED."brandColor",
        website = EXCLUDED.website,
        blurb = EXCLUDED.blurb,
        published_at = EXCLUDED.published_at
    `
  }

  await db`
    INSERT INTO chat_message (room, body, "authorName")
    SELECT * FROM (VALUES
      ('lobby', 'Morning. Is the coffee queue always like this?', 'Mira'),
      ('lobby', 'It is the only queue here that scales linearly.', 'Rune')
    ) AS seed(room, body, author)
    WHERE NOT EXISTS (SELECT 1 FROM chat_message WHERE room = 'lobby')
  `

  await db.end()
  console.log(
    `Done. ${SPEAKERS.length} speakers, ${TALKS.length} talks (one unpublished), 3 rooms, ` +
      `${SPONSORS.length} sponsors, one page, site settings and two lobby messages.`,
  )
}

seed().catch((e) => {
  console.error(e)
  process.exit(1)
})
