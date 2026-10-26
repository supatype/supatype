import { expect, test } from "@playwright/test"
import { expectDefects, on } from "../lib/defects.js"
import { rest, rows } from "../lib/http.js"
import { tier2UpdateDefects } from "../lib/matrix.js"
import { sql } from "../lib/stack.js"
import { PEOPLE, seed, storedEmployee, tokenOf, world } from "../lib/world.js"

/**
 * Writes through REST, checked against what the database actually stored.
 *
 * Every refusal is paired with a write the caller is allowed to make. A channel that refuses
 * everything would otherwise pass every "may not" check, which is how tier 2 looks today.
 * Ported from verify-scripts/t2/matrix.mjs ("REST writes") and t2/part2-extra.mjs.
 */

test.beforeEach(() => seed())

const idOf = (p: "a" | "b" | "admin"): string => world()[p].id

test("a user updates their own row", async () => {
  expectDefects(on({ 2: tier2UpdateDefects() }))
  const r = await rest(tokenOf("a"), "PATCH", `employee?id=eq.${idOf("a")}`, { name: "renamed-a" })
  expect(r.status, r.text).toBe(200)
  expect(rows(r)).toHaveLength(1)
  expect(storedEmployee("a")?.name).toBe("renamed-a")
})

test("a user cannot write the admin-only salary, even on their own row", async () => {
  expectDefects(on({ 2: tier2UpdateDefects() }))
  const control = await rest(tokenOf("a"), "PATCH", `employee?id=eq.${idOf("a")}`, { name: "control-a" })
  expect(control.status, `control: ${control.text}`).toBe(200)
  await rest(tokenOf("a"), "PATCH", `employee?id=eq.${idOf("a")}`, { salary: 1 })
  expect(storedEmployee("a")?.salary).toBe(String(PEOPLE.a.salary))
})

test("a refused write does not disclose masked values (T2-N1)", async () => {
  expectDefects(on({ 2: [...tier2UpdateDefects(), "T2-N1"] }))
  const own = await rest(tokenOf("b"), "PATCH", `employee?id=eq.${idOf("b")}`, { name: "control-b" })
  expect(own.status, `control: ${own.text}`).toBe(200)
  expect(rows(own)[0]?.["salary"] ?? null, "b's own salary is the admin's to read").toBeNull()
  const other = await rest(tokenOf("b"), "PATCH", `employee?id=eq.${idOf("a")}`, { name: "x" })
  expect(other.text).not.toContain(PEOPLE.a.ssn)
  expect(other.text).not.toContain(String(PEOPLE.a.salary))
})

test("an update or delete RLS refuses reports no row (T2-N2)", async () => {
  expectDefects(on({ 2: [...tier2UpdateDefects(), "T2-N2"] }))
  const own = await rest(tokenOf("b"), "PATCH", `employee?id=eq.${idOf("b")}`, { name: "control-b" })
  expect(own.status, `control: ${own.text}`).toBe(200)
  const patch = await rest(tokenOf("b"), "PATCH", `employee?id=eq.${idOf("a")}`, { name: "hacked" })
  expect(rows(patch), patch.text).toEqual([])
  const del = await rest(tokenOf("b"), "DELETE", `employee?id=eq.${idOf("a")}`)
  expect(rows(del), del.text).toEqual([])
  expect(storedEmployee("a")?.name).toBe(PEOPLE.a.name)
})

test("an insert applies the field write rules (T2-N3)", async () => {
  expectDefects(on({ 2: ["A3-N3", "T2-N3"] }))
  const del = await rest(tokenOf("a"), "DELETE", `employee?id=eq.${idOf("a")}`)
  expect(del.status, `control delete: ${del.text}`).toBe(200)
  expect(storedEmployee("a"), "control: a's own delete applied").toBeUndefined()
  const row = { id: idOf("a"), name: PEOPLE.a.name, grade: PEOPLE.a.grade, ssn: PEOPLE.a.ssn }
  await rest(tokenOf("a"), "POST", "employee", { ...row, salary: 999999 })
  expect(storedEmployee("a")?.salary ?? "", "the admin-only salary was not written").not.toBe("999999")
  if (storedEmployee("a") === undefined) {
    const plain = await rest(tokenOf("a"), "POST", "employee", row)
    expect(plain.status, `control insert without salary: ${plain.text}`).toBe(201)
  }
})

test("an insert takes the column defaults (T2-N4)", async () => {
  expectDefects(on({ 2: ["T2-N4"] }))
  const r = await rest(tokenOf("service_role"), "POST", "payslip", { dept: "ops", employee_id: idOf("b") })
  expect(r.status, r.text).toBe(201)
  expect(String(rows(r)[0]?.["ref"] ?? "")).toMatch(/^[0-9a-f-]{36}$/)
})

test("service_role writes a masked column (T2-N5)", async () => {
  expectDefects(on({ 2: ["T2-N5", "T2-N7"] }))
  const r = await rest(tokenOf("service_role"), "PATCH", `employee?id=eq.${idOf("b")}`, { salary: 3 })
  expect(r.status, r.text).toBe(200)
  expect(storedEmployee("b")?.salary).toBe("3")
})

test("the admin writes a salary on their own row", async () => {
  expectDefects(on({ 1: ["T1-N1"], 2: tier2UpdateDefects() }))
  const r = await rest(tokenOf("admin"), "PATCH", `employee?id=eq.${idOf("admin")}`, { salary: 310000 })
  expect(r.status, r.text).toBe(200)
  expect(storedEmployee("admin")?.salary).toBe("310000")
})

test("the admin cannot update another's row: updates are the owner's", async () => {
  expectDefects(on({ 2: tier2UpdateDefects() }))
  const control = await rest(tokenOf("admin"), "PATCH", `employee?id=eq.${idOf("admin")}`, { name: "control-z" })
  expect(control.status, `control: ${control.text}`).toBe(200)
  await rest(tokenOf("admin"), "PATCH", `employee?id=eq.${idOf("a")}`, { salary: 2 })
  expect(storedEmployee("a")?.salary).toBe(String(PEOPLE.a.salary))
})

test("anon inserts nothing", async () => {
  const id = "00000000-0000-0000-0000-0000000000ee"
  const r = await rest(tokenOf("anon"), "POST", "employee", { id, name: "eve", grade: 1 })
  expect(r.status, r.text).toBe(401)
  expect(sql(`select count(*) from public.employee where id = '${id}'`)).toBe("0")
})

test("a user cannot create a payslip: creation is the admin's", async () => {
  const before = sql("select count(*) from public.payslip")
  await rest(tokenOf("b"), "POST", "payslip", { dept: "eng", employee_id: idOf("b"), amount: 99999 })
  expect(sql("select count(*) from public.payslip")).toBe(before)
})
