import { expect, test } from "@playwright/test"
import { expectDefects } from "../lib/defects.js"
import { rest, rows, type Reply } from "../lib/http.js"
import { restReadDefects } from "../lib/matrix.js"
import { currentTier } from "../lib/stack.js"
import { PEOPLE, personOf, seed, tokenOf, type Caller, type Person } from "../lib/world.js"

/**
 * A masked column must not answer questions about itself: no filter, ordering, count, cast or
 * export may reveal what the caller cannot read. Each case says what every caller should get.
 * Ported from verify-scripts/t1/rest.mjs, t1/rest-extra.mjs and t2/matrix.mjs ("filter / sort").
 */
const tier = currentTier()

type Seen = string[]
interface OracleCase {
  name: string
  path: string
  headers?: Record<string, string>
  /** What the caller should see, reduced to something comparable. */
  read: (r: Reply) => Seen
  want: (caller: Caller) => Seen
}

const ids = (column: string) => (r: Reply): Seen =>
  rows(r).map((row) => personOf(row[column]) ?? String(row[column])).sort()
const names = (r: Reply): Seen => rows(r).map((row) => String(row["name"]))
const privileged = (c: Caller): boolean => c === "admin" || c === "service_role"
const sees = (c: Caller, p: Person): boolean => c === p || c === "service_role"

const CASES: OracleCase[] = [
  {
    name: "filter on salary",
    path: "employee?select=id&salary=gt.100000",
    read: ids("id"),
    want: (c) => (privileged(c) ? ["a", "admin"] : []),
  },
  {
    name: "exact match on another's ssn",
    path: `employee?select=id&ssn=eq.${PEOPLE.b.ssn}`,
    read: ids("id"),
    want: (c) => (sees(c, "b") ? ["b"] : []),
  },
  {
    name: "pattern match on another's ssn",
    path: "employee?select=id&ssn=like.SSN-B*",
    read: ids("id"),
    want: (c) => (sees(c, "b") ? ["b"] : []),
  },
  {
    name: "order by salary",
    path: "employee?select=name&order=salary.desc.nullslast,name.asc",
    read: names,
    want: (c) => (privileged(c) ? ["name-z", "name-a", "name-b"] : ["name-a", "name-b", "name-z"]),
  },
  {
    name: "or= across masked columns",
    path: `employee?select=id&or=(salary.gt.100000,ssn.eq.${PEOPLE.b.ssn})`,
    read: ids("id"),
    want: (c) => (c === "service_role" ? ["a", "admin", "b"] : c === "admin" ? ["a", "admin"] : c === "b" ? ["b"] : []),
  },
  {
    name: "exact count of a masked filter",
    path: "employee?select=id&salary=gt.100000",
    headers: { Prefer: "count=exact" },
    read: (r) => [r.headers.get("content-range")?.split("/")[1] ?? `status ${r.status}`],
    want: (c) => [privileged(c) ? "2" : "0"],
  },
  {
    name: "cast of a masked column",
    path: "employee?select=id,s:salary::text",
    read: (r) => rows(r).map((row) => `${personOf(row["id"]) ?? "?"}=${String(row["s"])}`).sort(),
    want: (c) => (["a", "admin", "b"] as const).map((p) => `${p}=${privileged(c) ? String(PEOPLE[p].salary) : "null"}`),
  },
  {
    name: "CSV export",
    path: "employee?select=name,salary,ssn&order=name",
    headers: { Accept: "text/csv" },
    read: (r) => [String(PEOPLE.b.salary), PEOPLE.b.ssn, String(PEOPLE.admin.salary)].filter((v) => r.text.includes(v)),
    want: (c) => (c === "service_role" ? [String(PEOPLE.b.salary), PEOPLE.b.ssn, String(PEOPLE.admin.salary)]
      : c === "admin" ? [String(PEOPLE.b.salary), String(PEOPLE.admin.salary)]
      : c === "b" ? [PEOPLE.b.ssn] : []),
  },
  {
    name: "filter on payslip amount",
    path: "payslip?select=employee_id&amount=gt.9000",
    read: ids("employee_id"),
    want: (c) => (privileged(c) ? ["a", "admin"] : []),
  },
  {
    name: "exact match on another's bank account",
    path: `payslip?select=employee_id&bank_account=eq.${PEOPLE.b.bank}`,
    read: ids("employee_id"),
    want: (c) => (sees(c, "b") ? ["b"] : []),
  },
]

test.beforeAll(() => seed())

for (const c of CASES) {
  for (const caller of ["a", "b", "admin", "service_role"] as const) {
    test(`${caller}: ${c.name}`, async () => {
      expectDefects(restReadDefects(tier, caller))
      const r = await rest(tokenOf(caller), "GET", c.path, undefined, c.headers ?? {})
      expect(r.status, r.text).toBeLessThan(300)
      expect(c.read(r)).toEqual(c.want(caller))
    })
  }
}

test("anon gets no answer to any of them", async () => {
  for (const c of CASES) {
    const r = await rest(tokenOf("anon"), "GET", c.path, undefined, c.headers ?? {})
    expect(r.status, `${c.name}: ${r.text}`).toBe(401)
  }
})
