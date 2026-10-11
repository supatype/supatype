import { expect, test } from "@playwright/test"
import { byPerson, expectedEmployees, expectedPayslips } from "../lib/expect-rows.js"
import { rest, rows } from "../lib/http.js"
import { CALLERS, seed, tokenOf } from "../lib/world.js"

/**
 * REST reads, every caller, both tables: who sees which rows, and which columns come back masked.
 * Ported from verify-scripts/t1/rest.mjs, t1/rest-embed.mjs and t2/matrix.mjs ("REST reads").
 */

test.beforeAll(() => seed())

for (const caller of CALLERS) {
  test(`${caller} reads employee`, async () => {
    const r = await rest(tokenOf(caller), "GET", "employee?select=id,name,grade,salary,ssn&order=name")
    if (caller === "anon") {
      expect(r.status, r.text).toBe(401)
      return
    }
    expect(r.status, r.text).toBe(200)
    expect(byPerson(rows(r), "id")).toEqual(expectedEmployees(caller))
  })

  test(`${caller} reads payslip`, async () => {
    const r = await rest(tokenOf(caller), "GET", "payslip?select=dept,employee_id,amount,bank_account&order=dept")
    if (caller === "anon") {
      expect(r.status, r.text).toBe(401)
      return
    }
    expect(r.status, r.text).toBe(200)
    expect(byPerson(rows(r), "employee_id")).toEqual(expectedPayslips(caller))
  })
}

// Embedding across two tables with masked columns, over REST.
for (const caller of ["a", "admin"] as const) {
  test(`${caller} embeds payslips in employees`, async () => {
    const r = await rest(tokenOf(caller), "GET", "employee?select=id,name,grade,salary,ssn,payslip(dept,amount,bank_account)")
    expect(r.status, r.text).toBe(200)
    const payslips = expectedPayslips(caller)
    const want = Object.fromEntries(
      Object.entries(expectedEmployees(caller)).map(([p, e]) => [p, { ...e, payslip: [payslips[p as keyof typeof payslips]] }]),
    )
    expect(byPerson(rows(r), "id")).toEqual(want)
  })
}
