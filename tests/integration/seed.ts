import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "@supatype/cli/seed"

function loadEnvFile(cwd: string): void {
  const path = join(cwd, ".env")
  if (!existsSync(path)) return
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadEnvFile(process.cwd())

const db = sql(
  process.env["DATABASE_URL"] ??
    "postgresql://supatype_admin:postgres@localhost:54329/supatype?sslmode=disable",
)

const AUTHOR_ID = "11111111-1111-4111-8111-111111111111"
const CAT_NEWS_ID = "22222222-2222-4222-8222-222222222221"
const CAT_GUIDES_ID = "22222222-2222-4222-8222-222222222222"

async function seed(): Promise<void> {
  console.log("Seeding supatype-integration demo data...")

  const existing = await db`SELECT COUNT(*)::int AS count FROM post`
  if ((existing.rows[0] as { count: number }).count > 0) {
    console.log("Posts already present — skipping seed.")
    await db.end()
    return
  }

  await db`
    INSERT INTO author (id, email, username, role)
    VALUES (${AUTHOR_ID}, 'demo@supatype.com', 'demo', 'admin')
    ON CONFLICT (email) DO NOTHING
  `

  await db`
    INSERT INTO category (id, name, slug, description, color, "isActive", "externalId")
    VALUES
      (${CAT_NEWS_ID}, 'News', 'news', 'Product updates and announcements', '#3b82f6', true, gen_random_uuid()),
      (${CAT_GUIDES_ID}, 'Guides', 'guides', 'How-to articles', '#10b981', true, gen_random_uuid())
    ON CONFLICT (slug) DO NOTHING
  `

  await db`
    INSERT INTO post (id, title, slug, excerpt, author_id, category_id, "viewCount")
    VALUES
      ('33333333-3333-4333-8333-333333333331', 'Welcome to Supatype', 'welcome-to-supatype', 'A quick tour of the integration stack.', ${AUTHOR_ID}, ${CAT_NEWS_ID}, 12),
      ('33333333-3333-4333-8333-333333333332', 'REST cache demo', 'rest-cache-demo', 'Reload the app to see server cache HIT.', ${AUTHOR_ID}, ${CAT_GUIDES_ID}, 4),
      ('33333333-3333-4333-8333-333333333333', 'Local dev with Docker', 'local-dev-docker', 'Kong, Studio, and Valkey on one port.', ${AUTHOR_ID}, ${CAT_NEWS_ID}, 7)
    ON CONFLICT (slug) DO NOTHING
  `

  await db.end()
  console.log("Done — open the app at your Kong URL (/) and reload to test cache.")
}

seed().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
