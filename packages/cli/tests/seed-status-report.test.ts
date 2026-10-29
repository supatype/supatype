import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reportSeedStatus } from "../src/commands/seed.js"

/**
 * Local test N4: `seed --status` against a database nothing listened on said "No seeds have been
 * applied to ...:5432" and exited 0. The engine had answered that it could not connect, and the
 * status reader looked only at the empty `files` list beside that error.
 */

const DSN = "postgresql://supatype_admin:secret@localhost:5432/app"
let printed: string[] = []

beforeEach(() => {
  printed = []
  const capture = (...args: unknown[]): void => {
    printed.push(args.map(String).join(" "))
  }
  vi.spyOn(console, "log").mockImplementation(capture)
  vi.spyOn(console, "error").mockImplementation(capture)
  vi.spyOn(console, "warn").mockImplementation(capture)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("reportSeedStatus", () => {
  it("says it could not connect, rather than that nothing was applied", () => {
    const code = reportSeedStatus(
      {
        files: [],
        error: {
          kind: "connection",
          message: "could not connect to the database: error communicating with database: connection refused",
          remedy: "Check the connection string, and that the stack is running.",
        },
      },
      DSN,
    )
    const output = printed.join("\n")
    expect(output).not.toMatch(/No seeds have been applied/)
    expect(output).toMatch(/could not connect to the database/)
    expect(output).not.toContain("secret")
    expect(code).toBe(2)
  })

  it("still says nothing was applied when the database answered with no runs", () => {
    expect(reportSeedStatus({ files: [] }, DSN)).toBe(0)
    expect(printed.join("\n")).toMatch(/No seeds have been applied to postgresql:\/\/supatype_admin:\*\*\*@localhost:5432\/app/)
  })
})
