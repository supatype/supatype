import { expect, test } from "@playwright/test"
import { gql, nodes, rest, rows } from "../lib/http.js"
import { currentTier, sql } from "../lib/stack.js"
import { PEOPLE, personOf, seed, tokenOf } from "../lib/world.js"

/**
 * A hand-written computed field over a table with masked columns: a function taking the row
 * type. It must see the caller's masked row, never the stored one. Tier 1 only: under tier 2 the
 * API reads the `api` views, whose row type such a function does not take.
 * Ported from verify-scripts/t1/T1-N4.sh, N3.mjs and N3-computed-field.sql.
 */
const SALARY_BAND = `
  CREATE OR REPLACE FUNCTION public.salary_band(e public.employee) RETURNS text
    LANGUAGE sql STABLE AS $$ SELECT concat('salary=', e.salary, ' ssn=', e.ssn) $$;
  GRANT EXECUTE ON FUNCTION public.salary_band(public.employee) TO authenticated`

const band = (salary: number | null, ssn: string | null): string => `salary=${salary ?? ""} ssn=${ssn ?? ""}`
const wantForA = {
  a: band(null, PEOPLE.a.ssn),
  b: band(null, null),
  admin: band(null, null),
}

if (currentTier() === 1) {
  test.beforeAll(() => {
    seed()
    sql(SALARY_BAND)
  })
  test.afterAll(() => sql("DROP FUNCTION IF EXISTS public.salary_band(public.employee)"))

  test("GraphQL serves a computed field over the masked row", async () => {
    const r = await gql(tokenOf("a"), "{ employeeCollection { edges { node { id salary_band } } } }")
    expect(r.errors).toEqual([])
    const got = Object.fromEntries(nodes(r, "employeeCollection").map((n) => [personOf(n["id"]) ?? "?", n["salary_band"]]))
    expect(got).toEqual(wantForA)
  })

  test("REST serves a computed column over the masked row", async () => {
    const r = await rest(tokenOf("a"), "GET", "employee?select=id,salary_band")
    expect(r.status, r.text).toBe(200)
    const got = Object.fromEntries(rows(r).map((n) => [personOf(n["id"]) ?? "?", n["salary_band"]]))
    expect(got).toEqual(wantForA)
  })
}
