import { describe, expect, it } from "vitest"
import {
  PASSWORD_PLACEHOLDER,
  authSchemaUsageCheck,
  type AuthSchemaUsageRow,
  needsOperatorPassword,
  operatorRemedies,
  transactionalRemedies,
  type CheckResult,
  type PreflightReport,
} from "../src/db-preflight.js"

// The preflight's live behaviour is exercised against a real database; these cover the decisions
// it makes about its own findings, which is where a mistake would be quiet rather than loud.

const result = (over: Partial<CheckResult>): CheckResult => ({
  id: "x",
  title: "x",
  severity: "pass",
  detail: "x",
  ...over,
})

const report = (results: CheckResult[]): PreflightReport => ({ results, worst: "pass" })

describe("splitting remedies", () => {
  // `--fix` runs everything it takes in one transaction. Anything that cannot be transactional
  // must be excluded, or the transaction fails and the fixable work rolls back with it.
  it("keeps server-setting remedies out of the transaction", () => {
    const r = report([
      result({ id: "roles", remedy: "CREATE ROLE anon;" }),
      result({ id: "wal", remedy: "ALTER SYSTEM SET wal_level = 'logical';", remedyNeedsOperator: true }),
      result({ id: "clean" }),
    ])

    expect(transactionalRemedies(r).map((x) => x.id)).toEqual(["roles"])
    expect(operatorRemedies(r).map((x) => x.id)).toEqual(["wal"])
  })

  it("ignores findings with nothing to apply", () => {
    const r = report([result({ id: "a" }), result({ id: "b", impact: "something is off" })])
    expect(transactionalRemedies(r)).toHaveLength(0)
    expect(operatorRemedies(r)).toHaveLength(0)
  })
})

describe("the authenticator password guard", () => {
  // The credential is the operator's by decision. Executing the placeholder would create a role
  // with a password from our source code, worse than refusing, and harder to notice.
  it("detects a remedy that would execute the placeholder", () => {
    const remedies = [
      result({ remedy: `CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD '${PASSWORD_PLACEHOLDER}';` }),
    ]
    expect(needsOperatorPassword(remedies)).toBe(true)
  })

  it("is satisfied once a real password is present", () => {
    const remedies = [
      result({ remedy: "CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD 'a-real-one';" }),
    ]
    expect(needsOperatorPassword(remedies)).toBe(false)
  })

  it("does not flag remedies that have no password at all", () => {
    expect(needsOperatorPassword([result({ remedy: "GRANT anon TO authenticator;" })])).toBe(false)
    expect(needsOperatorPassword([result({})])).toBe(false)
  })

  // The placeholder has to be something no operator would plausibly choose *and* invalid-looking,
  // so that if it ever did reach a database it would be obvious in pg_authid rather than subtle.
  it("uses an obviously-not-a-password placeholder", () => {
    expect(PASSWORD_PLACEHOLDER).toMatch(/^<.*>$/)
  })
})

describe("USAGE on the auth schema", () => {
  const row = (rolname: string, has_usage: boolean, owner = "supatype_admin"): AuthSchemaUsageRow => ({
    rolname,
    has_usage,
    owner,
  })
  const asOwner = { current_user: "supatype_admin", is_super: false }
  const asStranger = { current_user: "app_migrator", is_super: false }

  // Before the first push there is no auth schema, and the push creates it and grants on it.
  // Reporting that as a problem would send the operator to fix something that fixes itself.
  it("says nothing when the schema does not exist", () => {
    const check = authSchemaUsageCheck([], asOwner)
    expect(check.severity).toBe("pass")
    expect(check.remedy).toBeUndefined()
  })

  it("passes when all three roles hold usage, and names the owner", () => {
    const check = authSchemaUsageCheck(
      [row("anon", true), row("authenticated", true), row("service_role", true)],
      asOwner,
    )
    expect(check.severity).toBe("pass")
    expect(check.detail).toContain("supatype_admin")
    expect(check.remedy).toBeUndefined()
  })

  // Degrade, not fail: REST and RLS keep working because policies run with the table owner's
  // privileges. Calling it a failure would exit non-zero on databases using neither feature.
  it("degrades when a role lacks usage, and grants exactly that role", () => {
    const check = authSchemaUsageCheck(
      [row("anon", true), row("authenticated", false), row("service_role", true)],
      asOwner,
    )
    expect(check.severity).toBe("degrade")
    expect(check.remedy).toBe('GRANT USAGE ON SCHEMA auth TO "authenticated";')
    expect(check.impact).toContain("access.fields")
    expect(check.impact).toContain("42501")
  })

  it("grants every lacking role in one statement", () => {
    const check = authSchemaUsageCheck(
      [row("anon", false), row("authenticated", false), row("service_role", true)],
      asOwner,
    )
    expect(check.remedy).toBe('GRANT USAGE ON SCHEMA auth TO "anon", "authenticated";')
  })

  // `--fix` applies remedies in a transaction and reports "Applied". Postgres discards a grant
  // from a non-owner with a WARNING rather than an error, so without this flag `--fix` would
  // report success having changed nothing.
  it("hands the remedy to the operator when the caller cannot grant it", () => {
    const check = authSchemaUsageCheck([row("authenticated", false)], asStranger)
    expect(check.remedyNeedsOperator).toBe(true)
  })

  it("applies it itself when the caller owns the schema", () => {
    const check = authSchemaUsageCheck([row("authenticated", false)], asOwner)
    expect(check.remedyNeedsOperator).toBeUndefined()
  })

  it("applies it itself when the caller is a superuser on someone else's schema", () => {
    const check = authSchemaUsageCheck(
      [row("authenticated", false, "someone_else")],
      { current_user: "postgres", is_super: true },
    )
    expect(check.remedyNeedsOperator).toBeUndefined()
  })

  // A LEFT JOIN against a server with none of the API roles yields one all-null row. The roles
  // check owns that finding; reporting it here as a privilege problem points at the wrong fix.
  it("defers to the roles check when no API role exists", () => {
    const check = authSchemaUsageCheck([{ rolname: null, has_usage: null, owner: "postgres" }], asOwner)
    expect(check.severity).toBe("pass")
    expect(check.detail).toContain("no API roles")
  })
})
