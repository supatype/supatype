import { expect } from "vitest"
import { QUIET_SECRET_SQL } from "../../src/secret-sql.js"

/** Each line of the quiet preamble runs before the first statement in `sql` that names a password. */
export function expectQuietBeforePassword(sql: string | undefined): void {
  const text = sql ?? ""
  const password = text.search(/PASSWORD/i)
  expect(password).toBeGreaterThan(-1)
  for (const line of QUIET_SECRET_SQL.trim().split("\n")) {
    const at = text.indexOf(line)
    expect(at, line).toBeGreaterThan(-1)
    expect(at, line).toBeLessThan(password)
  }
}
