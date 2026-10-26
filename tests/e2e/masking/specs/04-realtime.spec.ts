import { expect, test } from "@playwright/test"
import { expectDefects, on } from "../lib/defects.js"
import { rowOf, type Event } from "../lib/realtime.js"
import { runScenario, type FeedName, type Scenario } from "../lib/realtime-scenario.js"
import { realtimeLogs } from "../lib/stack.js"
import { PEOPLE, world } from "../lib/world.js"

/**
 * Realtime: what each subscriber receives when service_role changes rows. Masking must hold on
 * every payload, a filter on a masked column must not act as an oracle, and nobody may learn of a
 * row they cannot see, by INSERT, UPDATE or DELETE.
 *
 * Tier 2 delivers nothing at all today (A3-N3), so every assertion there waits on a fence that
 * never arrives.
 */

let run: Scenario
test.beforeAll(async () => {
  test.setTimeout(240_000)
  run = await runScenario()
})

const events = (name: FeedName): Event[] => run.feeds[name].events
const idOf = (p: "a" | "b" | "admin"): string => world()[p].id
const about = (name: FeedName, rowId: string, type?: string): Event[] =>
  events(name).filter((e) => (rowOf(e)["id"] === rowId) && (type === undefined || e.eventType === type))

function fenced(...names: FeedName[]): void {
  for (const n of names) {
    expect(run.feeds[n].ready, `${n} joined`).toBe(true)
    expect(run.fences[n], `${n} received its fence`).toBe(true)
  }
}

test("every feed joined", () => {
  for (const [name, f] of Object.entries(run.feeds)) expect(f.ready, name).toBe(true)
})

test("a user receives another's row with the masked columns null", () => {
  expectDefects(on({ 2: ["A3-N3", "T2-N8"] }))
  fenced("a:employee")
  const [insert] = about("a:employee", idOf("b"), "INSERT")
  expect(insert?.new).toMatchObject({ name: PEOPLE.b.name, grade: PEOPLE.b.grade, salary: null, ssn: null })
})

test("a user receives their own ssn and not their salary", () => {
  expectDefects(on({ 2: ["A3-N3", "T2-N8"] }))
  fenced("a:employee")
  const [insert] = about("a:employee", idOf("a"), "INSERT")
  expect(insert?.new).toMatchObject({ ssn: PEOPLE.a.ssn, salary: null })
})

test("the admin receives salaries", () => {
  expectDefects(on({ 1: ["T1-N1"], 2: ["A3-N3"] }))
  fenced("admin:employee")
  const [insert] = about("admin:employee", idOf("b"), "INSERT")
  expect(insert?.new).toMatchObject({ salary: PEOPLE.b.salary, ssn: null })
})

test("a filter on a masked column delivers nothing", () => {
  expectDefects(on({ 2: ["A3-N3"] }))
  fenced("a:employee")
  expect(run.feeds["a:employee[salary]"].ready).toBe(true)
  expect(run.feeds["a:employee[ssn]"].ready).toBe(true)
  expect(events("a:employee[salary]"), "salary=gt.100000").toEqual([])
  expect(events("a:employee[ssn]"), `ssn=eq.${PEOPLE.b.ssn}`).toEqual([])
})

test("a filter compares numbers as numbers (T1-N3)", () => {
  expectDefects(on({ 1: ["T1-N3"], 2: ["A3-N3", "T1-N3"] }))
  fenced("a:employee[grade]")
  expect(about("a:employee[grade]", idOf("a")), "grade 9 is not > 10").toEqual([])
})

test("payslip events are masked and a DELETE carries only the key", () => {
  expectDefects(on({ 2: ["A3-N3", "T2-N8"] }))
  fenced("a:payslip")
  const mine = events("a:payslip").filter((e) => rowOf(e)["ref"] === run.refs.bPayslip)
  const insert = mine.find((e) => e.eventType === "INSERT")
  expect(insert?.new).toMatchObject({ dept: "eng", amount: null, bank_account: null })
  const del = mine.find((e) => e.eventType === "DELETE")
  expect(del?.old).toEqual({ ref: run.refs.bPayslip })
})

test("the payslip's owner receives their bank account", () => {
  expectDefects(on({ 2: ["A3-N3", "T2-N8"] }))
  fenced("a:payslip")
  const insert = events("b:payslip").find((e) => e.eventType === "INSERT" && rowOf(e)["ref"] === run.refs.bPayslip)
  expect(insert?.new).toMatchObject({ bank_account: PEOPLE.b.bank, amount: null })
})

test("nobody learns of a row they cannot see (P03)", () => {
  expectDefects(on({ 1: ["P03"], 2: ["A3-N3", "P03"] }))
  fenced("b:note")
  const aboutA = events("b:note").filter((e) => rowOf(e)["id"] === idOf("a"))
  expect(aboutA.map((e) => e.eventType), "a's note, insert, update and delete").toEqual([])
})

test("rows are keyed by their primary key, not the first column (M06)", () => {
  expectDefects(on({ 1: ["M06"], 2: ["A3-N3", "M06"] }))
  fenced("a:ticket")
  const codes = events("a:ticket").map((e) => String(rowOf(e)["code"]))
  expect(codes, "a's own ticket").toContain(run.refs.ownTicket)
  for (const stranger of [run.refs.strangerTicket, run.refs.otherTicket]) expect(codes).not.toContain(stranger)
})

test("realtime logs why it dropped an event (T2-N9)", () => {
  expectDefects(on({ 1: ["T2-N9"], 2: ["A3-N3", "T2-N9"] }))
  fenced("b:note")
  expect(realtimeLogs()).toMatch(/drop/i)
})
