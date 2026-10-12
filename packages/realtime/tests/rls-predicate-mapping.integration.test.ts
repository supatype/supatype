import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import pg from "pg"
import { RlsFilter } from "../src/rls.js"
import { A, ADMIN, B, RECORDED_TIER_SQL, admin, bob, change, userA, userB } from "./fixtures/tier2/people.js"

/**
 * Which predicate decides which column, when the engine had to number one (RT2-1).
 *
 * `Appraisal` in `tests/fixtures/tier2/schema.ts` has two field rules whose predicate names are the
 * same once cut to 63 bytes, so the engine names one of them `..._1`. Realtime used to rebuild the
 * name of each column's predicate from the naming rule, found a predicate it could not attribute to
 * one column, and withheld every change to the table under tier 2. The engine now records the
 * mapping in `_supatype.schema_state` (`capabilities.fieldMasking.columns`), and realtime reads it.
 *
 * Runs against databases the engine itself pushed, from `tests/fixtures/tier2/make-db.sh`:
 * `TIER2_DATABASE_URL` (tier 2, `api` views) and `TIER1_DATABASE_URL` (tier 1, made with tier `1`,
 * where the labels already name each column's predicate). Each tier skips without its URL.
 */
const TIERS = [
  { name: "tier 1 (supatype_mask labels)", url: process.env["TIER1_DATABASE_URL"], tier: "extension" },
  { name: "tier 2 (api views)", url: process.env["TIER2_DATABASE_URL"], tier: "views" },
] as const

const ALPHA = "manager_review_notes_for_the_quarterly_appraisal_alpha"
const BETA = "manager_review_notes_for_the_quarterly_appraisal_beta"

/** Bob's appraisal: the alpha notes are his to read, the beta notes the admin's. */
const bobs = { id: B, [ALPHA]: "alpha: for bob", [BETA]: "beta: for the admin" }

/** The recorded mapping, as the engine wrote it; the suites that remove it put it back from here. */
const RECORDED_COLUMNS_SQL = `SELECT capabilities #> '{fieldMasking,columns}' AS columns FROM _supatype.schema_state`

describe.each(TIERS)("$name: a column whose predicate the engine numbered", ({ url, tier }) => {
  let owner: pg.Client
  let filter: RlsFilter

  beforeAll(async () => {
    if (!url) return
    owner = new pg.Client({ connectionString: url })
    await owner.connect()
    // Tier 1 re-selects the row as the subscriber, so it has to exist. Tier 2 judges the WAL record
    // alone, and writes nothing here: the tier-2 database is shared with rls-tier2's suite.
    if (tier === "extension") {
      await owner.query(`
        INSERT INTO auth.users (id) VALUES ('${A}'), ('${B}'), ('${ADMIN}') ON CONFLICT DO NOTHING;
        INSERT INTO public.appraisal VALUES ('${B}', '${bobs[ALPHA]}', '${bobs[BETA]}') ON CONFLICT DO NOTHING;
      `)
    }
    filter = new RlsFilter(url)
  })

  afterAll(async () => {
    await filter?.shutdown()
    if (tier === "extension") await owner?.query(`DELETE FROM public.appraisal WHERE id = '${B}'`)
    await owner?.end()
  })

  afterEach(() => vi.restoreAllMocks())

  // The premise: without a numbered name there is nothing for the naming rule to get wrong.
  it.skipIf(!url)("is a schema the engine numbered a predicate for, and recorded", async () => {
    const recorded = await owner.query<{ tier: string }>(RECORDED_TIER_SQL)
    expect(recorded.rows[0]?.tier).toBe(tier)
    const names = await owner.query<{ name: string }>(
      `SELECT proname AS name FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND starts_with(proname, 'can_read_appraisal__')
        ORDER BY proname`,
    )
    expect(names.rows.map((row) => row.name)).toEqual([
      "can_read_appraisal__manager_review_notes_for_the_quarterly_ap_1",
      "can_read_appraisal__manager_review_notes_for_the_quarterly_appr",
    ])
    const columns = await owner.query<{ columns: Array<{ column: string; read: string }> }>(RECORDED_COLUMNS_SQL)
    const appraisal = columns.rows[0]?.columns.filter((entry) => entry.column.startsWith("manager_review"))
    expect(new Set(appraisal?.map((entry) => entry.read)).size).toBe(2)
  })

  it.skipIf(!url)("knows both columns are restricted", async () => {
    expect([...(await filter.maskedColumns("public", "appraisal"))].sort()).toEqual([ALPHA, BETA])
  })

  it.skipIf(!url)("delivers the owner the column only the owner may read, and nulls the other", async () => {
    const visible = await filter.visibleChange(userB, change("appraisal", "UPDATE", bobs))
    expect(visible?.newRecord).toEqual({ ...bobs, [BETA]: null })
  })

  it.skipIf(!url)("delivers the admin the column only an admin may read, and nulls the other", async () => {
    const visible = await filter.visibleChange(admin, change("appraisal", "UPDATE", bobs))
    expect(visible?.newRecord).toEqual({ ...bobs, [ALPHA]: null })
  })

  it.skipIf(!url)("delivers another user the row with both columns nulled", async () => {
    const visible = await filter.visibleChange(userA, change("appraisal", "UPDATE", bobs))
    expect(visible?.newRecord).toEqual({ ...bobs, [ALPHA]: null, [BETA]: null })
  })
})

/**
 * An engine before 0.7.0 records no mapping. Realtime then falls back to rebuilding names from the
 * naming rule: right for every predicate the engine did not number, and failing the table closed on
 * one it did, saying once per table that it is guessing.
 */
const tier2Url = process.env["TIER2_DATABASE_URL"]

describe.skipIf(!tier2Url)("tier 2 on a database whose engine recorded no mapping", () => {
  let owner: pg.Client
  let filter: RlsFilter
  let recorded: unknown

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: tier2Url })
    await owner.connect()
    recorded = (await owner.query<{ columns: unknown }>(RECORDED_COLUMNS_SQL)).rows[0]?.columns
    expect(recorded, "the engine under test records the mapping").toBeInstanceOf(Array)
    await owner.query(`UPDATE _supatype.schema_state SET capabilities = capabilities #- '{fieldMasking,columns}'`)
    filter = new RlsFilter(tier2Url!)
  })

  afterAll(async () => {
    await filter?.shutdown()
    if (Array.isArray(recorded)) {
      await owner.query(
        `UPDATE _supatype.schema_state
            SET capabilities = jsonb_set(capabilities, '{fieldMasking,columns}', $1::jsonb)`,
        [JSON.stringify(recorded)],
      )
    }
    await owner?.end()
  })

  afterEach(() => vi.restoreAllMocks())

  it("masks by the naming rule where the engine did not number a predicate, and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    // Twice, with a push in between, so the second read goes to the database again.
    for (let i = 0; i < 2; i++) {
      const visible = await filter.visibleChange(userA, change("employee", "UPDATE", bob))
      expect(visible?.newRecord).toEqual({ ...bob, salary: null, ssn: null })
      filter.invalidateCatalogs()
    }
    const fallbacks = warn.mock.calls.filter(([line]) => String(line).includes("naming rule"))
    expect(fallbacks).toEqual([[expect.stringContaining("public.employee")]])
  })

  it("withholds every change to a table with a numbered predicate rather than guess", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await filter.visibleChange(userB, change("appraisal", "UPDATE", bobs))).toBeNull()
    // Which name it meets first decides whether it reads "0 columns" (the numbered one) or "2".
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/field predicate can_read_appraisal__\w+ matches [02] columns of appraisal/),
    )
  })
})
