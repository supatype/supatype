import { describe, expect, it } from "vitest"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { QueryResult } from "pg"
import { ensureFirstAdminWithQuery } from "../src/commands/admin.js"

function result(rows: Record<string, unknown>[]): QueryResult {
  return {
    rows,
    rowCount: rows.length,
    command: "SELECT",
    oid: 0,
    fields: [],
  } as unknown as QueryResult
}

interface Recorded {
  sql: string
  params: unknown[]
}

/**
 * Answers the probes `ensureFirstAdminWithQuery` makes and records every
 * statement, so the assertions can inspect what would reach Postgres.
 */
function stubDb(): { query: (sql: string, params?: unknown[]) => Promise<QueryResult>; log: Recorded[] } {
  const log: Recorded[] = []
  const query = async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    log.push({ sql, params })

    if (sql.includes("information_schema.tables") && sql.includes("'auth'")) {
      return result([{ exists: true }])
    }
    if (sql.includes("to_regclass")) {
      return result([{ exists: false }]) // no membership table yet → no admins
    }
    if (sql.includes("information_schema.columns")) {
      return result([{ column_name: "email_confirmed_at" }])
    }
    if (sql.includes("SELECT id FROM auth.users")) {
      return result([]) // email not taken
    }
    if (sql.includes("INSERT INTO auth.users")) {
      return result([{ id: "11111111-2222-3333-4444-555555555555", email: "admin@example.com" }])
    }
    return result([])
  }
  return { query, log }
}

async function seedFirstAdmin(): Promise<Recorded[]> {
  const dir = join(tmpdir(), `supatype-admin-membership-${process.pid}-${Math.random()}`)
  mkdirSync(dir, { recursive: true })
  const { query, log } = stubDb()
  try {
    await ensureFirstAdminWithQuery(query, {
      cwd: dir,
      email: "admin@example.com",
      password: "password123",
      role: "admin",
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return log
}

describe("first admin user creation", () => {
  // Regression: Studio access used to be granted by writing `role` into
  // `app_metadata`. That is the developer's namespace for their own application
  // roles, so anything that assigned an app role could hand out admin UI access.
  it("does not write a role into app_metadata", async () => {
    const log = await seedFirstAdmin()
    const insert = log.find((entry) => entry.sql.includes("INSERT INTO auth.users"))
    expect(insert).toBeDefined()

    const appMetadata = insert!.params.find(
      (p): p is string => typeof p === "string" && p.trimStart().startsWith("{"),
    )
    expect(appMetadata).toBeDefined()
    expect(JSON.parse(appMetadata!)).not.toHaveProperty("role")
  })

  it("grants Studio access through _supatype.studio_members", async () => {
    const log = await seedFirstAdmin()
    const grant = log.find((entry) =>
      entry.sql.includes("INSERT INTO _supatype.studio_members"),
    )
    expect(grant).toBeDefined()
    expect(grant!.params).toEqual(["11111111-2222-3333-4444-555555555555", "admin"])
  })

  // The membership table is the only grant, so `admin create-user` has to work
  // on a project whose engine predates it or that has never been pushed.
  it("creates the membership table when it is absent", async () => {
    const log = await seedFirstAdmin()
    expect(
      log.some((entry) => entry.sql.includes("CREATE TABLE IF NOT EXISTS _supatype.studio_members")),
    ).toBe(true)
  })

  // Counting `app_metadata` claims would report an admin exists while nobody
  // can actually log in, so the "do I need a first admin?" check must read
  // membership.
  it("decides whether an admin exists from membership, not claims", async () => {
    const log = await seedFirstAdmin()
    const probe = log.find((entry) => entry.sql.includes("COUNT(*)"))
    expect(probe?.sql ?? "").not.toContain("raw_app_meta_data")
  })
})
