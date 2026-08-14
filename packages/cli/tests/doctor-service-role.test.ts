import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

// `doctor` reaches this section only after talking to the engine, so the printing is exercised here
// instead: the section is how an operator answers "which of my functions can bypass every access rule?"
const lines: string[] = []
vi.mock("../src/ui/messages.js", () => ({
  plain: (line?: string) => lines.push(line ?? ""),
  info: () => {},
}))

const { printServiceRoleGrants } = await import("../src/commands/doctor.js")

beforeEach(() => {
  lines.length = 0
})
afterEach(() => {
  vi.clearAllMocks()
})

const empty = { errors: [], missing: [], warnings: [], available: [] }

describe("printServiceRoleGrants", () => {
  it("prints nothing when a project grants nothing", () => {
    printServiceRoleGrants(empty, [])
    expect(lines).toEqual([])
  })

  it("lists every grant, and says what the list means", () => {
    printServiceRoleGrants(empty, ["audit", "send-email"])
    const out = lines.join("\n")
    expect(out).toContain("Service-role grants (2)")
    expect(out).toContain("• audit")
    expect(out).toContain("• send-email")
    expect(out).toContain("bypass every access rule")
  })

  it("marks a grant that matches no function", () => {
    printServiceRoleGrants(
      { ...empty, errors: ['  "send-emial" — no functions/send-emial/index.ts'], missing: ["send-emial"] },
      ["send-emial", "audit"],
    )
    const out = lines.join("\n")
    expect(out).toContain("✗ send-emial")
    expect(out).toContain("• audit")
    expect(out).toContain("grant nothing")
  })

  it("passes a redundant-entry warning through", () => {
    printServiceRoleGrants(
      { ...empty, warnings: ['  "hooks/x" is not needed — a hook receives the key'] },
      ["hooks/x"],
    )
    expect(lines.join("\n")).toContain("is not needed")
  })
})
