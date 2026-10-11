import { describe, expect, it } from "vitest"

/**
 * IN-A: `supatype migrate` asks the engine for the file with no lock taken, and `--record` passes
 * through so the engine rehearses the push and the file records it too.
 */

const { endpointToArgs } = await import("../src/engine-client.js")
const { migrateRequest, migrationSql } = await import("../src/commands/migrate.js")

describe("supatype migrate", () => {
  it("asks the engine for the file without --record unless asked, and passes --record through", () => {
    const plain = migrateRequest({}, "postgres://x", "public", {})
    expect(plain["record"]).toBe(false)
    expect(endpointToArgs("/migrate", plain, { reqFile: "req.json" })).toEqual([
      "migrate",
      "--input",
      "req.json",
      "--schema",
      "public",
    ])
    const recorded = migrateRequest({}, "postgres://x", "app", { record: true, force: true })
    expect(endpointToArgs("/migrate", recorded, { reqFile: "req.json" })).toEqual([
      "migrate",
      "--input",
      "req.json",
      "--schema",
      "app",
      "--force",
      "--record",
    ])
  })

  it("reads the SQL from the binary's output or a server's answer", () => {
    expect(migrationSql({ message: "BEGIN;\nCOMMIT;\n" })).toBe("BEGIN;\nCOMMIT;")
    expect(migrationSql({ sql: "SELECT 1;" })).toBe("SELECT 1;")
    expect(() => migrationSql({})).toThrow(/no SQL/)
  })
})
