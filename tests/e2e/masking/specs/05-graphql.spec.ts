import { expect, test } from "@playwright/test"
import { byPerson, expectedEmployees, expectedPayslips } from "../lib/expect-rows.js"
import { gql, nodes } from "../lib/http.js"
import { CALLERS, PEOPLE, personOf, seed, tokenOf, type Caller } from "../lib/world.js"

/**
 * GraphQL (pg_graphql through /graphql/v1): the same rules as REST, plus the filters, orderings
 * and cursors GraphQL offers on a masked column. Ported from verify-scripts/t1/gql.mjs,
 * t1/gql-queries.mjs, t1/gql-nested.mjs and t2/matrix.mjs ("GraphQL").
 */
const cursor = (value: number, id: string): string => Buffer.from(JSON.stringify([value, id])).toString("base64")

test.beforeAll(() => seed())

test("anon is offered no model", async () => {
  const r = await gql(tokenOf("anon"), "{ employeeCollection { edges { node { id } } } }")
  expect(r.errors.join(" ")).toContain('Unknown field "employeeCollection"')
})

for (const caller of CALLERS.filter((c) => c !== "anon")) {
  test(`${caller} reads employees`, async () => {
    const r = await gql(tokenOf(caller), "{ employeeCollection { edges { node { id name grade salary ssn } } } }")
    expect(r.errors).toEqual([])
    expect(byPerson(nodes(r, "employeeCollection"), "id")).toEqual(expectedEmployees(caller))
  })

  test(`${caller} reads payslips`, async () => {
    const r = await gql(tokenOf(caller), "{ payslipCollection { edges { node { dept employee_id amount bank_account } } } }")
    expect(r.errors).toEqual([])
    expect(byPerson(nodes(r, "payslipCollection"), "employee_id")).toEqual(expectedPayslips(caller))
  })
}

interface GqlOracle {
  name: string
  query: string
  collection: string
  read: (row: Record<string, unknown>) => string
  want: (caller: Caller) => string[]
}

const privileged = (c: Caller): boolean => c === "admin" || c === "service_role"
const who = (column: string) => (row: Record<string, unknown>): string => personOf(row[column]) ?? String(row[column])

const ORACLES: GqlOracle[] = [
  {
    name: "filter on salary",
    query: "{ employeeCollection(filter: {salary: {gt: 100000}}) { edges { node { id } } } }",
    collection: "employeeCollection",
    read: who("id"),
    want: (c) => (privileged(c) ? ["a", "admin"] : []),
  },
  {
    name: "filter on another's ssn",
    query: `{ employeeCollection(filter: {ssn: {eq: "${PEOPLE.b.ssn}"}}) { edges { node { id } } } }`,
    collection: "employeeCollection",
    read: who("id"),
    want: (c) => (c === "b" || c === "service_role" ? ["b"] : []),
  },
  {
    name: "order by salary",
    query: "{ employeeCollection(orderBy: [{salary: DescNullsLast}, {name: AscNullsLast}]) { edges { node { name } } } }",
    collection: "employeeCollection",
    read: (row) => String(row["name"]),
    want: (c) => (privileged(c) ? ["name-z", "name-a", "name-b"] : ["name-a", "name-b", "name-z"]),
  },
  {
    name: "forged keyset cursor on salary",
    query: `{ employeeCollection(orderBy: [{salary: AscNullsLast}, {id: AscNullsLast}], after: "${cursor(100000, "00000000-0000-0000-0000-000000000000")}") { edges { node { id } } } }`,
    collection: "employeeCollection",
    read: who("id"),
    want: (c) => (privileged(c) ? ["a", "admin"] : []),
  },
  {
    name: "filter on payslip amount",
    query: "{ payslipCollection(filter: {amount: {gt: 9000}}) { edges { node { employee_id } } } }",
    collection: "payslipCollection",
    read: who("employee_id"),
    want: (c) => (privileged(c) ? ["a", "admin"] : []),
  },
]

const ordered = (o: GqlOracle): boolean => o.name.startsWith("order")

for (const o of ORACLES) {
  for (const caller of ["a", "b", "admin", "service_role"] as const) {
    test(`${caller}: ${o.name}`, async () => {
      const r = await gql(tokenOf(caller), o.query)
      expect(r.errors).toEqual([])
      const got = nodes(r, o.collection).map(o.read)
      expect(ordered(o) ? got : got.sort()).toEqual(o.want(caller))
    })
  }
}

// A nested collection over a table with a masked column (T1-N2, fixed by F66). service_role is
// unmasked, so it is the control.
for (const caller of ["a", "admin", "service_role"] as const) {
  test(`${caller} reads a nested relation (T1-N2)`, async () => {
    const r = await gql(tokenOf(caller), "{ employeeCollection { edges { node { id payslipCollection { edges { node { dept } } } } } } }")
    expect(r.errors).toEqual([])
    const employees = nodes(r, "employeeCollection")
    expect(employees).toHaveLength(3)
    for (const e of employees) expect(nodes({ status: 200, data: e, errors: [] }, "payslipCollection")).toEqual([{ dept: "eng" }])
  })
}
