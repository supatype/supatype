import { PEOPLE, PERSONS, personOf, type Caller, type Person } from "./world.js"

/**
 * What each caller should read, in every tier: the rules in project/schema/index.ts applied by hand.
 *
 * - every signed-in caller sees every employee and payslip row; anon sees none;
 * - `salary` and `amount` are the admin's;
 * - `ssn` and `bank_account` are their owner's;
 * - service_role reads everything.
 */
const readsEverything = (caller: Caller): boolean => caller === "service_role"
const isAdmin = (caller: Caller): boolean => caller === "admin" || readsEverything(caller)
const owns = (caller: Caller, person: Person): boolean => caller === person || readsEverything(caller)

export function expectedEmployee(caller: Caller, person: Person): Record<string, unknown> {
  const p = PEOPLE[person]
  return {
    name: p.name,
    grade: p.grade,
    salary: isAdmin(caller) ? p.salary : null,
    ssn: owns(caller, person) ? p.ssn : null,
  }
}

export function expectedPayslip(caller: Caller, person: Person): Record<string, unknown> {
  const p = PEOPLE[person]
  return {
    dept: "eng",
    amount: isAdmin(caller) ? p.amount : null,
    bank_account: owns(caller, person) ? p.bank : null,
  }
}

/** Rows keyed by the person they belong to, through the id column named. */
export function byPerson(rows: Record<string, unknown>[], idColumn: string): Partial<Record<Person, Record<string, unknown>>> {
  const out: Partial<Record<Person, Record<string, unknown>>> = {}
  for (const row of rows) {
    const who = personOf(row[idColumn])
    if (who === undefined) continue
    const { [idColumn]: _id, ...rest } = row
    out[who] = rest
  }
  return out
}

export function expectedEmployees(caller: Caller): Record<Person, Record<string, unknown>> {
  return Object.fromEntries(PERSONS.map((p) => [p, expectedEmployee(caller, p)])) as Record<Person, Record<string, unknown>>
}

export function expectedPayslips(caller: Caller): Record<Person, Record<string, unknown>> {
  return Object.fromEntries(PERSONS.map((p) => [p, expectedPayslip(caller, p)])) as Record<Person, Record<string, unknown>>
}

/** Callers whose reads depend on the admin role, which T1-N1 disables on a fresh tier-1 stack. */
export const needsAdminRole = (caller: Caller): boolean => caller === "admin"
