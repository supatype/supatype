import { describe, expect, it } from "vitest"
import { foreignTables } from "../src/db-preflight.js"

/**
 * Preflight's "existing tables" warning. Since the engine stopped stamping (managed-object
 * ownership Phase 6) a table Supatype created carries no comment, so the warning must read the
 * ledger, or it would name every table a push made.
 */
type Query = Parameters<typeof foreignTables>[0]

/** A query function that answers the ledger probe with `ledger` and records every statement. */
function fake(ledger: boolean, tables: string[]): { q: Query; seen: string[] } {
  const seen: string[] = []
  const q = (async <T,>(sql: string): Promise<T[]> => {
    seen.push(sql)
    const rows = sql.includes("to_regclass") ? [{ present: ledger }] : tables.map((relname) => ({ relname }))
    return rows as unknown as T[]
  }) as Query
  return { q, seen }
}

describe("foreignTables()", () => {
  it("leaves out what the ledger records as Supatype's", async () => {
    const { q, seen } = fake(true, ["theirs"])
    expect(await foreignTables(q, "public")).toEqual(["theirs"])
    expect(seen[1]).toContain("_supatype.managed_objects")
    expect(seen[1]).toContain("status <> 'released'")
  })

  it("does not name the ledger on a database that has none yet", async () => {
    const { q, seen } = fake(false, [])
    await foreignTables(q, "public")
    expect(seen[1]).not.toContain("_supatype.managed_objects")
  })

  it("still leaves out what an older engine stamped", async () => {
    const { q, seen } = fake(true, [])
    await foreignTables(q, "public")
    expect(seen[1]).toContain("NOT LIKE 'supatype:managed%'")
  })
})
