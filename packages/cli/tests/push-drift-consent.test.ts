import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The linked and self-hosted push path reads a diff first and asks before it pushes. A person who
// declines keeps the hand edits and the push exits 1, as the docker path does on the engine's
// refusal (`drift-consent.test.ts`), so a script sees the same outcome on either.
const answer = vi.hoisted(() => ({ value: false }))
vi.mock("../src/ui/confirm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/confirm.js")>()),
  confirm: vi.fn(async () => answer.value),
}))
vi.mock("../src/ui/interactive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/interactive.js")>()),
  isInteractive: () => true,
}))

const { consentToSecurityDrift } = await import("../src/commands/push.js")

const drifted = {
  reconcile: [
    {
      action: "drift",
      security_relevant: true,
      key: { kind: "policy", schema: "public", parent: "posts", name: "read" },
      recorded_def: "USING (true)",
      live_def: "USING (false)",
    },
  ],
} as unknown as Parameters<typeof consentToSecurityDrift>[0]

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe("consentToSecurityDrift()", () => {
  it("declined at the prompt: nothing is pushed and the push exits 1", async () => {
    answer.value = false
    expect(await consentToSecurityDrift(drifted, { yes: false, overwriteDrift: false })).toBeNull()
    expect(process.exitCode).toBe(1)
  })

  it("accepted at the prompt: the push overwrites, exit code untouched", async () => {
    answer.value = true
    expect(await consentToSecurityDrift(drifted, { yes: false, overwriteDrift: false })).toBe(true)
    expect(process.exitCode).toBeUndefined()
  })

  it("without a person to ask it stops with exit 1, as before", async () => {
    expect(await consentToSecurityDrift(drifted, { yes: true, overwriteDrift: false })).toBeNull()
    expect(process.exitCode).toBe(1)
  })

  it("nothing drifted: nothing to ask", async () => {
    expect(await consentToSecurityDrift({ reconcile: [] }, { yes: false, overwriteDrift: false })).toBe(false)
    expect(process.exitCode).toBeUndefined()
  })
})
