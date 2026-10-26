import { expect, test } from "@playwright/test"
import { rowOf, type Event } from "../lib/realtime.js"
import { runScenario, type FeedName, type Scenario } from "../lib/realtime-scenario.js"
import { realtimeLogs } from "../lib/stack.js"
import { PEOPLE, world } from "../lib/world.js"

/**
 * Realtime: what each subscriber receives when service_role changes rows. Masking must hold on
 * every payload, a filter on a masked column must not act as an oracle, and nobody may learn of a
 * row they cannot see, by INSERT, UPDATE or DELETE.
 *
 * Fences are INSERTs and UPDATEs only. A DELETE reaches a subscriber only when the table carries
 * its whole old row (REPLICA IDENTITY FULL), so DELETE delivery is asserted on its own rather than
 * gating the other checks (it was TEST-1-N1 until the engine set the identity, F68).
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
  fenced("a:employee")
  const [insert] = about("a:employee", idOf("b"), "INSERT")
  expect(insert?.new).toMatchObject({ name: PEOPLE.b.name, grade: PEOPLE.b.grade, salary: null, ssn: null })
})

test("a user receives their own ssn and not their salary", () => {
  fenced("a:employee")
  const [insert] = about("a:employee", idOf("a"), "INSERT")
  expect(insert?.new).toMatchObject({ ssn: PEOPLE.a.ssn, salary: null })
})

test("the admin receives salaries", () => {
  fenced("admin:employee")
  const [insert] = about("admin:employee", idOf("b"), "INSERT")
  expect(insert?.new).toMatchObject({ salary: PEOPLE.b.salary, ssn: null })
})

test("a filter on a masked column delivers nothing", () => {
  fenced("a:employee")
  expect(run.feeds["a:employee[salary]"].ready).toBe(true)
  expect(run.feeds["a:employee[ssn]"].ready).toBe(true)
  expect(events("a:employee[salary]"), "salary=gt.100000").toEqual([])
  expect(events("a:employee[ssn]"), `ssn=eq.${PEOPLE.b.ssn}`).toEqual([])
})

test("a filter compares numbers as numbers", () => {
  fenced("a:employee[grade]")
  expect(about("a:employee[grade]", idOf("a")), "grade 9 is not > 10").toEqual([])
})

const payslipEvents = (name: FeedName): Event[] => events(name).filter((e) => rowOf(e)["ref"] === run.refs.bPayslip)

test("payslip events are masked", () => {
  fenced("a:payslip")
  const insert = payslipEvents("a:payslip").find((e) => e.eventType === "INSERT")
  expect(insert?.new).toMatchObject({ dept: "eng", amount: null, bank_account: null })
})

test("a DELETE reaches a subscriber who could see the row, with nothing masked in it", () => {
  fenced("a:payslip")
  const del = payslipEvents("a:payslip").find((e) => e.eventType === "DELETE")
  expect(del?.old?.["ref"], "the deleted payslip's key").toBe(run.refs.bPayslip)
  expect(del?.old?.["amount"] ?? null, "amount is the admin's").toBeNull()
  expect(del?.old?.["bank_account"] ?? null, "bank_account is b's").toBeNull()
})

test("a DELETE of a row with NULL columns reaches a subscriber who could see it (TEST-1-N2)", () => {
  fenced("a:payslip")
  const del = events("a:payslip").find((e) => e.eventType === "DELETE" && rowOf(e)["ref"] === run.refs.nullPayslip)
  expect(del?.old?.["ref"], "the deleted payslip's key").toBe(run.refs.nullPayslip)
  // The NULL columns wal2json left out come back as null, not as absent keys.
  expect(del?.old, "the old row has every column").toHaveProperty("bank_account", null)
})

test("the payslip's owner receives their bank account", () => {
  fenced("b:payslip")
  const insert = events("b:payslip").find((e) => e.eventType === "INSERT" && rowOf(e)["ref"] === run.refs.bPayslip)
  expect(insert?.new).toMatchObject({ bank_account: PEOPLE.b.bank, amount: null })
})

test("nobody learns of a row they cannot see (P03)", () => {
  fenced("b:note")
  const aboutA = events("b:note").filter((e) => rowOf(e)["id"] === idOf("a"))
  expect(aboutA.map((e) => e.eventType), "a's note, insert, update and delete").toEqual([])
})

test("rows are keyed by their primary key, not the first column (M06)", () => {
  fenced("a:ticket")
  const codes = events("a:ticket").map((e) => String(rowOf(e)["code"]))
  expect(codes, "a's own ticket").toContain(run.refs.ownTicket)
  for (const stranger of [run.refs.strangerTicket, run.refs.otherTicket]) expect(codes).not.toContain(stranger)
})

// A withheld event is logged only at REALTIME_LOG_LEVEL=debug, which masking-e2e.sh sets (R2).
test("realtime logs why it dropped an event (T2-N9)", () => {
  fenced("b:note")
  expect(realtimeLogs()).toMatch(/dropped \w+ on \S+ for role \w+: .*not visible to subscriber/)
})
