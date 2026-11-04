import { describe, expect, it } from "vitest"
import {
  PASSWORD_PLACEHOLDER,
  afterHooksSourceCheck,
  claimsSchemaUsageCheck,
  decodingProblem,
  type ClaimsSchemaUsageRow,
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

describe("USAGE on the _supatype schema, where the generated rules read the JWT", () => {
  const row = (rolname: string, has_usage: boolean, owner = "supatype_admin"): ClaimsSchemaUsageRow => ({
    rolname,
    has_usage,
    owner,
  })
  const asOwner = { current_user: "supatype_admin", is_super: false }
  const asStranger = { current_user: "app_migrator", is_super: false }

  // Before the first push there is no _supatype schema, and the push creates it and grants on it.
  // Reporting that as a problem would send the operator to fix something that fixes itself.
  it("says nothing when the schema does not exist", () => {
    const check = claimsSchemaUsageCheck([], asOwner)
    expect(check.severity).toBe("pass")
    expect(check.remedy).toBeUndefined()
  })

  it("passes when all three roles hold usage, and names the owner", () => {
    const check = claimsSchemaUsageCheck(
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
    const check = claimsSchemaUsageCheck(
      [row("anon", true), row("authenticated", false), row("service_role", true)],
      asOwner,
    )
    expect(check.severity).toBe("degrade")
    expect(check.remedy).toBe('GRANT USAGE ON SCHEMA _supatype TO "authenticated";')
    expect(check.impact).toContain("access.fields")
    expect(check.impact).toContain("42501")
  })

  it("grants every lacking role in one statement", () => {
    const check = claimsSchemaUsageCheck(
      [row("anon", false), row("authenticated", false), row("service_role", true)],
      asOwner,
    )
    expect(check.remedy).toBe('GRANT USAGE ON SCHEMA _supatype TO "anon", "authenticated";')
  })

  // `--fix` applies remedies in a transaction and reports "Applied". Postgres discards a grant
  // from a non-owner with a WARNING rather than an error, so without this flag `--fix` would
  // report success having changed nothing.
  it("hands the remedy to the operator when the caller cannot grant it", () => {
    const check = claimsSchemaUsageCheck([row("authenticated", false)], asStranger)
    expect(check.remedyNeedsOperator).toBe(true)
  })

  it("applies it itself when the caller owns the schema", () => {
    const check = claimsSchemaUsageCheck([row("authenticated", false)], asOwner)
    expect(check.remedyNeedsOperator).toBeUndefined()
  })

  it("applies it itself when the caller is a superuser on someone else's schema", () => {
    const check = claimsSchemaUsageCheck(
      [row("authenticated", false, "someone_else")],
      { current_user: "postgres", is_super: true },
    )
    expect(check.remedyNeedsOperator).toBeUndefined()
  })

  // A LEFT JOIN against a server with none of the API roles yields one all-null row. The roles
  // check owns that finding; reporting it here as a privilege problem points at the wrong fix.
  it("defers to the roles check when no API role exists", () => {
    const check = claimsSchemaUsageCheck([{ rolname: null, has_usage: null, owner: "postgres" }], asOwner)
    expect(check.severity).toBe("pass")
    expect(check.detail).toContain("no API roles")
  })
})

/**
 * A database that answers `SHOW wal_level` with `level`, has `used` of 10 slots taken, and refuses
 * the probe slot with `refusal`.
 */
function decodingDatabase(level: string, refusal?: { code: string; message: string }, used = "0", existing = "") {
  return async (sql: string): Promise<Array<Record<string, unknown>>> => {
    if (sql.startsWith("SHOW wal_level")) return [{ wal_level: level }]
    if (sql.includes("max_replication_slots")) return [{ used, max: "10", existing, role: "postgres" }]
    if (sql.includes("pg_create_logical_replication_slot") && refusal !== undefined) {
      throw Object.assign(new Error(refusal.message), { code: refusal.code })
    }
    return []
  }
}

describe("the logical decoding probe", () => {
  // supatype/postgres allowlists output plugins, and refuses an unlisted one with the same SQLSTATE
  // as a role without REPLICATION (42501, measured on supatype/postgres:latest 2026-11-03). Reading
  // every 42501 as the role sent the operator to grant an attribute the role already had.
  it("tells an output plugin allowlist refusal from a missing REPLICATION attribute", async () => {
    const allowlist = decodingDatabase("logical", {
      code: "42501",
      message: 'library "wal2json" may not be used as an output plugin',
    })
    expect(await decodingProblem(allowlist)).toContain("output_plugin_libraries")

    const noReplication = decodingDatabase("logical", {
      code: "42501",
      message: "permission denied to use replication slots",
    })
    expect(await decodingProblem(noReplication)).toContain("REPLICATION")
  })

  it("says nothing when a slot can be created and dropped", async () => {
    expect(await decodingProblem(decodingDatabase("logical"))).toBeUndefined()
  })

  // doctor and native dev ask this; `db check` runs the full list. With no slot free, `db check`
  // said after-hooks were on the request path while doctor said the change log.
  it("names a full slot budget, as db check does", async () => {
    expect(await decodingProblem(decodingDatabase("logical", undefined, "10"))).toContain("10 of 10 in use")
  })

  // Realtime and the after-hook listener each keep a slot of their own, so one free slot fits
  // only one of them.
  it("needs a free slot for each of realtime and the listener not yet created, and names the one left out", async () => {
    const oneFree = await decodingProblem(decodingDatabase("logical", undefined, "9"))
    expect(oneFree).toContain("supatype_hooks")
    expect(oneFree).not.toContain("supatype_realtime")
    expect(await decodingProblem(decodingDatabase("logical", undefined, "9", "supatype_realtime"))).toBeUndefined()
  })

  // The probe runs as whoever `db check` connected as, which need not be the role the server's
  // listener connects with, so the answer says which role it was.
  it("names the role it checked", async () => {
    const noReplication = decodingDatabase("logical", { code: "42501", message: "permission denied to use replication slots" })
    expect(await decodingProblem(noReplication)).toContain('role "postgres"')
  })
})

describe("where after-hooks read writes from", () => {
  const decoding = (over: Partial<CheckResult>): CheckResult =>
    result({ id: "logical-decoding", title: "wal2json logical decoding", ...over })

  it("is the change log when the database can decode", () => {
    const check = afterHooksSourceCheck([result({ id: "wal-level" }), decoding({})])
    expect(check.severity).toBe("pass")
    expect(check.detail).toContain("change log")
  })

  it("falls back to the request path, saying why and what it misses", () => {
    const check = afterHooksSourceCheck([
      result({ id: "wal-level", severity: "degrade", detail: 'wal_level is "replica"' }),
    ])
    expect(check.severity).toBe("degrade")
    expect(check.detail).toContain("request path")
    expect(check.detail).toContain('wal_level is "replica"')
    expect(check.impact).toContain("outside the API")
  })
})
