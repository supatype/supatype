import { feed, signedInClient, sleep, waitFor, type Event, type Feed } from "./realtime.js"
import { literal as q, sql } from "./stack.js"
import { PEOPLE, seed, world, type Person } from "./world.js"

/**
 * One realtime run, shared by every assertion in 04-realtime.spec.ts: subscribe, change rows,
 * then wait for fences. A fence is a change the subscriber is certainly allowed to see; until it
 * arrives, the absence of any other event proves nothing.
 *
 * The changes are made in SQL as supatype_admin, not over REST as service_role (as the T1 script
 * did). Realtime reads them from the WAL either way, and this way the scenario does not depend on
 * the REST write path, which tier 2 once broke (T2-N4, T2-N7): a driver that threw there left
 * every realtime assertion unrun.
 *
 * Ported from verify-scripts/t1/realtime.mjs (masking and filters), a3/M06.ts (Ticket) and
 * a7/P03.mjs (Note).
 */

export type FeedName =
  | "a:employee" | "b:employee" | "admin:employee" | "a:payslip" | "b:payslip"
  | "a:employee[salary]" | "a:employee[ssn]" | "a:employee[grade]" | "a:ticket" | "b:note"

export interface Scenario {
  feeds: Record<FeedName, Feed>
  /** Keys of rows the scenario created, by their part in the story. */
  refs: { bPayslip: string; strangerTicket: string; otherTicket: string; ownTicket: string; fenceTicket: string }
  fences: Record<string, boolean>
}

const id = (p: Person): string => world()[p].id

/** One statement, then a pause so each change is its own transaction in the subscriber's order. */
async function change(statement: string): Promise<string> {
  const out = sql(statement)
  await sleep(300)
  return out
}

async function subscribeAll(): Promise<Record<FeedName, Feed>> {
  const a = await signedInClient("a")
  const b = await signedInClient("b")
  const admin = await signedInClient("admin")
  return {
    "a:employee": await feed(a, "employee"),
    "b:employee": await feed(b, "employee"),
    "admin:employee": await feed(admin, "employee"),
    "a:payslip": await feed(a, "payslip"),
    "b:payslip": await feed(b, "payslip"),
    "a:employee[salary]": await feed(a, "employee", "salary=gt.100000"),
    "a:employee[ssn]": await feed(a, "employee", `ssn=eq.${PEOPLE.b.ssn}`),
    "a:employee[grade]": await feed(a, "employee", "grade=gt.10"),
    "a:ticket": await feed(a, "ticket"),
    "b:note": await feed(b, "note"),
  }
}

const insertEmployee = (p: Person): string => {
  const x = PEOPLE[p]
  return `insert into public.employee (id, name, grade, salary, ssn) values (${[id(p), x.name, x.grade, x.salary, x.ssn].map(q).join(",")})`
}

async function driveEmployees(): Promise<string> {
  await change(insertEmployee("b"))
  await change(`update public.employee set name = 'name-b2' where id = ${q(id("b"))}`)
  await change(insertEmployee("a"))
  const ref = await change(`insert into public.payslip (dept, employee_id, amount, bank_account) values ('eng', ${q(id("b"))}, 8000, ${q(PEOPLE.b.bank)}) returning ref`)
  await change(`update public.payslip set amount = 8100 where ref = ${q(ref)}`)
  await change(`delete from public.payslip where ref = ${q(ref)}`)
  return ref
}

async function driveTickets(): Promise<Omit<Scenario["refs"], "bPayslip">> {
  const ticket = (owner: Person, category: string, label: string) =>
    change(`insert into public.ticket (category, owner_id, label) values (${[category, id(owner), label].map(q).join(",")}) returning code`)
  const own = await ticket("a", "shared", "own")
  const stranger = await ticket("b", "shared", "stranger-same-category")
  const other = await ticket("b", "other", "stranger-other-category")
  await change(`update public.ticket set label = 'stranger-updated' where code = ${q(stranger)}`)
  await change(`delete from public.ticket where code = ${q(stranger)}`)
  const fence = await ticket("a", "fence", "own-fence")
  return { ownTicket: own, strangerTicket: stranger, otherTicket: other, fenceTicket: fence }
}

async function driveNotes(): Promise<void> {
  await change(`insert into public.note (id, body) values (${q(id("a"))}, 'secret-of-a')`)
  await change(`update public.note set body = 'secret-of-a-2' where id = ${q(id("a"))}`)
  await change(`delete from public.note where id = ${q(id("a"))}`)
  await change(`insert into public.note (id, body) values (${q(id("b"))}, 'fence-b')`)
}

async function awaitFences(feeds: Record<FeedName, Feed>, fenceTicket: string, bPayslip: string): Promise<Record<string, boolean>> {
  await change(`update public.employee set name = 'fence-a' where id = ${q(id("a"))}`)
  const fenceName = (e: Event) => e.new?.["name"] === "fence-a"
  const fences: Record<string, boolean> = {}
  for (const name of ["a:employee", "b:employee", "admin:employee"] as const) fences[name] = await waitFor(feeds[name].events, fenceName)
  fences["a:employee[grade]"] = await waitFor(feeds["a:employee[grade]"].events, (e) => e.new?.["id"] === id("b"))
  const payslipInsert = (e: Event) => e.eventType === "INSERT" && e.new?.["ref"] === bPayslip
  fences["a:payslip"] = await waitFor(feeds["a:payslip"].events, payslipInsert)
  fences["b:payslip"] = await waitFor(feeds["b:payslip"].events, payslipInsert)
  fences["a:ticket"] = await waitFor(feeds["a:ticket"].events, (e) => e.new?.["code"] === fenceTicket)
  fences["b:note"] = await waitFor(feeds["b:note"].events, (e) => e.new?.["id"] === id("b"))
  await sleep(2000)
  return fences
}

export async function runScenario(): Promise<Scenario> {
  seed()
  sql(`delete from public.employee where id in (${q(id("a"))}, ${q(id("b"))})`)
  const feeds = await subscribeAll()
  await sleep(1500)
  const bPayslip = await driveEmployees()
  const tickets = await driveTickets()
  await driveNotes()
  const fences = await awaitFences(feeds, tickets.fenceTicket, bPayslip)
  for (const f of Object.values(feeds)) f.unsubscribe()
  return { feeds, refs: { ...tickets, bPayslip }, fences }
}
