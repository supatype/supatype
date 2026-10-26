import { afterEach, describe, expect, it, vi } from "vitest"
import { EngineError } from "../src/engine-client.js"

/**
 * IN-C 3: a push that would rewrite a large table, stopping its reads and writes while it runs, is
 * refused by the engine without `force`. It goes through the same consent as a destructive change:
 * `push --yes` applies it, a terminal is asked, and anywhere else it is refused with the command
 * that applies it on purpose.
 */

const lines: string[] = []
vi.mock("../src/ui/messages.js", () => ({
  plain: (line?: string) => lines.push(line ?? ""),
  warn: (line: string) => lines.push(`warn: ${line}`),
}))

const { DestructiveChangeRefused, pushConsentingToDestructive } = await import("../src/destructive-consent.js")
const { consentRefusal } = await import("../src/push-refusal.js")

/** What the engine binary prints when a push without `--force` would rewrite a large table. */
const REWRITE_TEXT =
  "Error: 1 operation(s) rewrite a large table, which stops every read and write on it until the push " +
  "commits: items.qty changes its type from int4 to BIGINT: locks items while it rewrites ~120000 rows. " +
  "Use --force to proceed."
const refusal = () => new EngineError(`Engine /push failed (exit 1): ${REWRITE_TEXT}`, "/push", 1, "")
const policy = { yes: false, apply: "supatype push --yes" }

afterEach(() => {
  lines.length = 0
  vi.restoreAllMocks()
})

describe("consentRefusal()", () => {
  it("reads a rewrite refusal as one a person can consent to, and a destructive one as before", () => {
    expect(consentRefusal(REWRITE_TEXT)).toEqual({ kind: "rewrite", count: 1 })
    expect(consentRefusal("Error: 2 destructive operation(s) detected. Use --force to proceed.")).toEqual({
      kind: "destructive",
      count: 2,
    })
    expect(consentRefusal("connection refused")).toBeNull()
  })
})

describe("pushConsentingToDestructive() on a large rewrite", () => {
  it("off a terminal refuses, naming the table and how to apply it on purpose", async () => {
    const push = vi.fn(async (force: boolean) => {
      if (!force) throw refusal()
      return "forced"
    })
    const refused = pushConsentingToDestructive(push, policy, { interactive: () => false })
    await expect(refused).rejects.toBeInstanceOf(DestructiveChangeRefused)
    await expect(refused).rejects.toThrow(/supatype push --yes/)
    expect(push.mock.calls).toEqual([[false]])
    expect(lines.join("\n")).toContain("locks items while it rewrites ~120000 rows")
  })

  it("with --yes pushes again forced", async () => {
    const push = vi.fn(async (force: boolean) => {
      if (!force) throw refusal()
      return "forced"
    })
    expect(await pushConsentingToDestructive(push, { ...policy, yes: true })).toBe("forced")
    expect(push.mock.calls).toEqual([[false], [true]])
  })

  it("in a terminal asks about the lock, not about lost data, and forces only on yes", async () => {
    const push = vi.fn(async (force: boolean) => {
      if (!force) throw refusal()
      return "forced"
    })
    const ask = vi.fn(async () => false)
    await expect(pushConsentingToDestructive(push, policy, { interactive: () => true, ask })).rejects.toBeInstanceOf(
      DestructiveChangeRefused,
    )
    expect(ask).toHaveBeenCalledWith("Apply it and lock the table while it is rewritten?")
    expect(push.mock.calls).toEqual([[false]])
  })
})
