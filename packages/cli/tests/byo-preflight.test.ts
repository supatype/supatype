import { describe, expect, it } from "vitest"
import { byoGapLines, findByoGaps } from "../src/byo-preflight.js"

/**
 * T2-N11: a push to plain Postgres failed in the engine with `role "anon" does not exist`, then with
 * `relation "auth.users" does not exist`, one raw error at a time. The gaps are listed first, each
 * with what closes it.
 */
const USERS_AST = { models: [{ name: "Payslip", fields: { owner: { kind: "relation", target: "supatype:user" } } }] }
const PLAIN_AST = { models: [{ name: "Note", fields: { title: { kind: "scalar" } } }] }

function database(roles: string[], authUsers: boolean) {
  return async (sql: string): Promise<Array<Record<string, unknown>>> =>
    sql.includes("pg_roles") ? roles.map((rolname) => ({ rolname })) : [{ present: authUsers }]
}

describe("findByoGaps", () => {
  it("names every missing API role", async () => {
    expect(await findByoGaps(database(["anon"], true), PLAIN_AST)).toEqual({
      missingRoles: ["authenticated", "service_role"],
      missingAuthUsers: false,
    })
  })

  it("asks for auth.users only when a model relates to users", async () => {
    expect((await findByoGaps(database([], false), PLAIN_AST)).missingAuthUsers).toBe(false)
    expect((await findByoGaps(database([], false), USERS_AST)).missingAuthUsers).toBe(true)
    expect((await findByoGaps(database([], true), USERS_AST)).missingAuthUsers).toBe(false)
  })
})

describe("byoGapLines", () => {
  it("says nothing when nothing is missing", () => {
    expect(byoGapLines({ missingRoles: [], missingAuthUsers: false })).toEqual([])
  })

  it("gives the statement for each missing role, and the step for auth.users", () => {
    const text = byoGapLines({ missingRoles: ["anon", "service_role"], missingAuthUsers: true }).join("\n")
    expect(text).toContain('CREATE ROLE "anon" NOLOGIN NOINHERIT;')
    expect(text).toContain("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;")
    expect(text).toContain("auth.users")
    expect(text).toContain("supatype db check --connection")
  })
})
