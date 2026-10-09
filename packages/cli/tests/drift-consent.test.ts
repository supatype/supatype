import { afterEach, describe, expect, it, vi } from "vitest"
import { askToOverwrite, pushConsentingToDrift } from "../src/drift-consent.js"
import { EngineError } from "../src/engine-client.js"

/** What the engine binary does on a docker push it refuses: exit 1, the JSON reason on stdout. */
const refusal = () =>
  new EngineError(
    "Engine /push failed (exit 1): Error: 1 object(s) that decide who may read or write were changed outside Supatype",
    "/push",
    1,
    JSON.stringify({
      status: "refused",
      reason: "security_drift",
      objects: [{ key: { kind: "policy", schema: "public", parent: "posts", name: "read" }, recorded: "USING (true)", live: "USING (false)" }],
    }),
  )

function output(): () => string {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  return () => log.mock.calls.map((c) => c.join(" ")).join("\n")
}

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe("pushConsentingToDrift()", () => {
  it("shows what drifted, asks, and on yes pushes again with overwrite_drift", async () => {
    const printed = output()
    const calls: boolean[] = []
    const push = vi.fn(async (overwrite: boolean) => {
      calls.push(overwrite)
      if (!overwrite) throw refusal()
      return "applied"
    })
    const beforeOverwrite = vi.fn(async () => undefined)
    const ask = vi.fn(async () => true)
    const result = await pushConsentingToDrift(push, { overwriteDrift: false, yes: false }, {
      beforeOverwrite,
      ask,
      interactive: () => true,
    })
    expect(result).toBe("applied")
    expect(calls).toEqual([false, true])
    expect(beforeOverwrite).toHaveBeenCalledOnce()
    expect(ask).toHaveBeenCalledWith("Put Supatype's definitions back?")
    expect(printed()).toContain("policy posts.read")
    expect(printed()).toContain("USING (false)")
  })

  it("keeps the hand edit on no: one push, exit 1", async () => {
    const printed = output()
    const push = vi.fn(async () => {
      throw refusal()
    })
    const result = await pushConsentingToDrift(push, { overwriteDrift: false, yes: false }, {
      ask: async () => false,
      interactive: () => true,
    })
    expect(result).toBeUndefined()
    expect(push).toHaveBeenCalledOnce()
    expect(process.exitCode).toBe(1)
    expect(printed()).toContain("The changes made outside Supatype were kept")
  })

  it("never takes the consent for itself with --yes or without a terminal", async () => {
    output()
    for (const policy of [
      { yes: true, interactive: true },
      { yes: false, interactive: false },
    ]) {
      const ask = vi.fn(async () => true)
      const push = vi.fn(async () => {
        throw refusal()
      })
      await expect(
        pushConsentingToDrift(push, { overwriteDrift: false, yes: policy.yes }, { ask, interactive: () => policy.interactive }),
      ).rejects.toBeInstanceOf(EngineError)
      expect(ask).not.toHaveBeenCalled()
      expect(push).toHaveBeenCalledOnce()
    }
  })

  it("sends --overwrite-drift on the first push when it was passed, and rethrows other failures", async () => {
    const push = vi.fn(async (overwrite: boolean) => overwrite)
    expect(await pushConsentingToDrift(push, { overwriteDrift: true, yes: true })).toBe(true)
    const boom = new Error("boom")
    await expect(
      pushConsentingToDrift(async () => {
        throw boom
      }, { overwriteDrift: false, yes: false }),
    ).rejects.toBe(boom)
  })
})

describe("askToOverwrite()", () => {
  it("is yes to put Supatype's definitions back", async () => {
    output()
    expect(await askToOverwrite({ ask: async () => true })).toBe(true)
    expect(process.exitCode).toBeUndefined()
  })

  it("keeps the hand edits on no and exits 1", async () => {
    const printed = output()
    expect(await askToOverwrite({ ask: async () => false })).toBe(false)
    expect(process.exitCode).toBe(1)
    expect(printed()).toContain("The changes made outside Supatype were kept; nothing was applied.")
  })
})
