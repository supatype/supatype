import { describe, expect, it } from "vitest"
import { formatMigration } from "../src/commands/migrate.js"
import { resolveAuthor } from "../src/push-audit.js"

/**
 * Issue 65: on a machine where git has no user name, `migrations list` printed
 * "nic (OS user, unverified) (unverified)": the recorded author said unverified, and the list says
 * it again from `pushedByVerified`. The recorded author now says only where the name came from.
 */
describe("migrations list's author", () => {
  it("says unverified once for an OS user's push", () => {
    const pushedBy = resolveAuthor({ git: () => undefined, osUser: () => "nic" })
    const printed = formatMigration({
      id: 1,
      name: "push_20261107_232344_801",
      hash: "sha256:0",
      appliedAt: "2026-11-07 23:23:44.802809+00",
      rolledBack: false,
      engineVersion: "0.10.0-dev",
      status: "applied",
      pushedBy,
      pushedVia: "cli",
      pushedFrom: "NJ",
      pushedByVerified: false,
    })
    expect(printed).toContain("author: nic (OS user) (unverified)")
    expect(printed.match(/unverified/g)).toHaveLength(1)
  })
})
