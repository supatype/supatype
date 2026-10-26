import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"
import { RlsFilter } from "../src/rls.js"
import type { JwtClaims } from "../src/auth.js"
import type { WalChange } from "../src/types.js"

/**
 * Realtime under tier 2: a database without `supatype_mask`, where the engine enforces field rules
 * with `api` views and gives the API roles no privilege on the model tables.
 *
 * Re-selecting the row from the base table fails there for every subscriber, and there are no
 * security labels to read the masked columns from, so this suite needs a database the engine
 * itself pushed: `tests/fixtures/tier2/make-db.sh` builds one from `tests/fixtures/tier2/schema.ts`
 * (`Employee`: `name` LoggedIn, `salary` admin only, `ssn` owner only; `Payslip`, keyed by `ref`,
 * with `amount` readable by its owner). Point `TIER2_DATABASE_URL` at it. Skips otherwise.
 */
const databaseUrl = process.env["TIER2_DATABASE_URL"]

const A = "0a0a0a0a-0000-4000-8000-00000000000a"
const B = "0b0b0b0b-0000-4000-8000-00000000000b"
const ADMIN = "0d0d0d0d-0000-4000-8000-00000000000d"

const userA = { sub: A, role: "authenticated" } as JwtClaims
const admin = { sub: ADMIN, role: "authenticated", app_metadata: { role: "admin" } } as JwtClaims
const anon = { role: "anon" } as JwtClaims
const service = { role: "service_role" } as JwtClaims

const bob = { id: B, name: "Bob", salary: 90000, ssn: "B-SSN-222" }
const bobsPayslip = { ref: "0e0e0e0e-0000-4000-8000-00000000000e", owner_id: B, month: "2026-09", amount: 7500 }

function change(table: string, event: WalChange["event"], row: Record<string, unknown>): WalChange {
  return {
    schema: "public",
    table,
    event,
    newRecord: event === "DELETE" ? null : row,
    oldRecord: event === "DELETE" ? row : null,
    exactColumns: {},
    columnTypes: {},
    commitTimestamp: new Date().toISOString(),
  }
}

describe.skipIf(!databaseUrl)("RlsFilter under tier 2 (api views, no labels)", () => {
  let owner: pg.Client
  let filter: RlsFilter

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: databaseUrl })
    await owner.connect()
    const tier = await owner.query<{ tier: string | null }>(
      `SELECT capabilities->'fieldMasking'->>'tier' AS tier FROM _supatype.schema_state`,
    )
    // The premise of the suite: a database that would make the old code drop everything.
    expect(tier.rows[0]?.tier).toBe("views")
    await owner.query(`
      INSERT INTO auth.users VALUES ('${A}'), ('${B}'), ('${ADMIN}') ON CONFLICT DO NOTHING;
      INSERT INTO public.employee VALUES ('${B}', 'Bob', 90000, 'B-SSN-222') ON CONFLICT DO NOTHING;
      INSERT INTO public.payslip VALUES ('${bobsPayslip.ref}', '${B}', '2026-09', 7500) ON CONFLICT DO NOTHING;
    `)
    filter = new RlsFilter(databaseUrl!)
  })

  afterAll(async () => {
    await filter?.shutdown()
    await owner?.query(`DELETE FROM public.payslip; DELETE FROM public.employee; DELETE FROM auth.users`)
    await owner?.end()
  })

  it("reads the masked columns from the generated predicates, not from labels", async () => {
    expect([...(await filter.maskedColumns("public", "employee"))].sort()).toEqual(["name", "salary", "ssn"])
    expect([...(await filter.maskedColumns("public", "payslip"))]).toEqual(["amount"])
  })

  it("delivers another user's row to a user, with the columns they may not read nulled", async () => {
    for (const event of ["INSERT", "UPDATE"] as const) {
      const visible = await filter.visibleChange(userA, change("employee", event, bob))
      expect(visible?.newRecord).toEqual({ ...bob, salary: null, ssn: null })
    }
  })

  it("delivers the salary to an admin", async () => {
    const visible = await filter.visibleChange(admin, change("employee", "UPDATE", bob))
    expect(visible?.newRecord).toEqual({ ...bob, ssn: null })
  })

  it("delivers the owner their own ssn", async () => {
    const userB = { sub: B, role: "authenticated" } as JwtClaims
    const visible = await filter.visibleChange(userB, change("employee", "UPDATE", bob))
    expect(visible?.newRecord).toEqual({ ...bob, salary: null })
  })

  it("delivers nothing to anon", async () => {
    for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
      expect(await filter.visibleChange(anon, change("employee", event, bob))).toBeNull()
    }
  })

  it("applies an OwnerFrom field rule on a table not keyed by id", async () => {
    const forA = await filter.visibleChange(userA, change("payslip", "INSERT", bobsPayslip))
    expect(forA?.newRecord).toEqual({ ...bobsPayslip, amount: null })
    const userB = { sub: B, role: "authenticated" } as JwtClaims
    const forB = await filter.visibleChange(userB, change("payslip", "INSERT", bobsPayslip))
    expect(forB?.newRecord).toEqual(bobsPayslip)
  })

  it("judges a DELETE's full old row the same way", async () => {
    const visible = await filter.visibleChange(userA, change("employee", "DELETE", bob))
    expect(visible?.oldRecord).toEqual({ ...bob, salary: null, ssn: null })
  })

  // Tier 1 exempts service_role, and the engine is being changed (F63) so tier 2 does too.
  it("sends service_role everything, unmasked", async () => {
    const visible = await filter.visibleChange(service, change("employee", "UPDATE", bob))
    expect(visible?.newRecord).toEqual(bob)
  })
})
