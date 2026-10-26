import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { call } from "./http.js"
import { currentTier, literal, sql, stack } from "./stack.js"

/**
 * The people in the matrix and the rows they own.
 *
 * Names sort a, b, z while salaries sort z, a, b (descending), so an ordering on a masked column
 * that follows the hidden values is told apart from one that does not. `grade` 9 against a filter
 * of `gt.10` is what a string comparison gets wrong ("9" > "10").
 */
export const PEOPLE = {
  a: { name: "name-a", grade: 9, salary: 120000, ssn: "SSN-A-111", bank: "BANK-A", amount: 10000 },
  b: { name: "name-b", grade: 12, salary: 95000, ssn: "SSN-B-222", bank: "BANK-B", amount: 7916 },
  admin: { name: "name-z", grade: 20, salary: 300000, ssn: "SSN-ADMIN-000", bank: "BANK-ADMIN", amount: 25000 },
} as const

export type Person = keyof typeof PEOPLE
export const PERSONS: readonly Person[] = ["a", "b", "admin"]

export type Caller = "anon" | Person | "service_role"
export const CALLERS: readonly Caller[] = ["anon", "a", "b", "admin", "service_role"]

export interface Account {
  id: string
  email: string
  password: string
  token: string
}

export type World = Record<Person, Account>

const PASSWORD = "Correct-Horse-9"
const stateDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".state")
const statePath = (): string => join(stateDir, `world-tier${currentTier()}.json`)

async function signIn(email: string): Promise<{ id: string; token: string }> {
  const r = await call("POST", "/auth/v1/token?grant_type=password", stack().anonKey, { email, password: PASSWORD })
  const body = r.body as { access_token?: string; user?: { id?: string } } | null
  if (r.status !== 200 || typeof body?.access_token !== "string" || typeof body.user?.id !== "string") {
    throw new Error(`sign in ${email}: ${r.status} ${r.text.slice(0, 200)}`)
  }
  return { id: body.user.id, token: body.access_token }
}

async function createAccount(person: Person, run: string): Promise<Account> {
  const email = `masking-${person}-${run}@example.test`
  const appMetadata = person === "admin" ? { role: "admin" } : {}
  const created = await call("POST", "/auth/v1/admin/users", stack().serviceKey, {
    email, password: PASSWORD, email_confirm: true, app_metadata: appMetadata,
  }, { apikey: stack().serviceKey })
  if (created.status >= 300) throw new Error(`create ${person}: ${created.status} ${created.text.slice(0, 200)}`)
  const { id, token } = await signIn(email)
  return { id, email, password: PASSWORD, token }
}

/** Global setup: one account per person on this stack, written where every spec can read it. */
export async function createWorld(): Promise<World> {
  const run = Date.now().toString(36)
  const world: World = {
    a: await createAccount("a", run),
    b: await createAccount("b", run),
    admin: await createAccount("admin", run),
  }
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(statePath(), JSON.stringify(world, null, 2))
  return world
}

let loaded: World | undefined
export function world(): World {
  loaded ??= JSON.parse(readFileSync(statePath(), "utf8")) as World
  return loaded
}

export function tokenOf(caller: Caller): string {
  if (caller === "anon") return stack().anonKey
  if (caller === "service_role") return stack().serviceKey
  return world()[caller].token
}

/** Which person an id belongs to, so assertions and failure messages read as names. */
export function personOf(id: unknown): Person | undefined {
  return PERSONS.find((p) => world()[p].id === id)
}


/**
 * Puts the tables back to the known state, as supatype_admin, so every case starts from the same
 * rows whatever the previous one wrote. Employees go in b, a, admin order, so the physical order
 * matches neither the name nor the salary order.
 */
export function seed(): void {
  const w = world()
  const employees = (["b", "a", "admin"] as const).map((p) => {
    const x = PEOPLE[p]
    return `(${[w[p].id, x.name, x.grade, x.salary, x.ssn].map(literal).join(",")})`
  })
  const payslips = (["b", "a", "admin"] as const).map((p) => {
    const x = PEOPLE[p]
    return `(${["eng", w[p].id, x.amount, x.bank].map(literal).join(",")})`
  })
  sql([
    "delete from public.ticket where true",
    "delete from public.note where true",
    "delete from public.payslip where true",
    "delete from public.employee where true",
    `insert into public.employee (id, name, grade, salary, ssn) values ${employees.join(",")}`,
    `insert into public.payslip (dept, employee_id, amount, bank_account) values ${payslips.join(",")}`,
  ].join("; "))
}

/** The stored employee row of a person, read past every rule. */
export function storedEmployee(person: Person): { name: string; salary: string; ssn: string } | undefined {
  const line = sql(`select name || '|' || coalesce(salary::text, '') || '|' || coalesce(ssn, '') from public.employee where id = '${world()[person].id}'`)
  if (line === "") return undefined
  const [name = "", salary = "", ssn = ""] = line.split("|")
  return { name, salary, ssn }
}
