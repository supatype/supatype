import { sql } from "@supatype/cli/seed"

// Connect using DATABASE_URL from environment
const db = sql(
  process.env["DATABASE_URL"] ??
    "postgresql://supatype_admin:postgres@localhost:5432/supatype",
)

async function seed() {
  console.log("Seeding supatype...")

  // TODO: insert seed data
  // await db`INSERT INTO users (email, name) VALUES ('admin@example.com', 'Admin')`

  await db.end()
  console.log("Done.")
}

seed().catch((e) => {
  console.error(e)
  process.exit(1)
})
