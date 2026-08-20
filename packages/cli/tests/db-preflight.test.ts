import { describe, expect, it } from "vitest"
import {
  PASSWORD_PLACEHOLDER,
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
