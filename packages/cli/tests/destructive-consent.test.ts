import { afterEach, describe, expect, it, vi } from "vitest"
import { EngineError } from "../src/engine-client.js"

/**
 * A push that would drop data needs a person's say. `supatype dev` used to push every change with
 * `--force --non-interactive`, so a rename the engine did not recognise dropped the column and every
 * value in it, and dev printed nothing about it. Pushes now go unforced first: the engine refuses,
 * and the person is asked (in a terminal) or told how to apply it on purpose (anywhere else).
 */

const lines: string[] = []
vi.mock("../src/ui/messages.js", () => ({
  plain: (line?: string) => lines.push(line ?? ""),
  warn: (line: string) => lines.push(`warn: ${line}`),
}))

const { DESTRUCTIVE_CHANGE_HINT, DestructiveChangeRefused, pushConsentingToDestructive } = await import(
  "../src/destructive-consent.js"
)
const { destructiveRefusal } = await import("../src/push-refusal.js")

/** What the engine binary prints when a push without `--force` would drop something. */
const REFUSAL_TEXT = "Error: 1 destructive operation(s) detected. Use --force to proceed."
const refusal = () => new EngineError(`Engine /push failed (exit 1): ${REFUSAL_TEXT}`, "/push", 1, "")

const policy = { yes: false, apply: "supatype push --yes" }

afterEach(() => {
  lines.length = 0
  vi.restoreAllMocks()
})

describe("destructiveRefusal()", () => {
  it("reads the count from the engine's refusal, from the binary or the compose output", () => {
    expect(destructiveRefusal(REFUSAL_TEXT)).toBe(1)
    expect(destructiveRefusal(`schema-engine-1  | Error: 3 destructive operation(s) detected. Use --force to proceed.`)).toBe(3)
  })

  it("is null for any other failure", () => {
    expect(destructiveRefusal("connection refused")).toBeNull()
    expect(destructiveRefusal("")).toBeNull()
  })
})

describe("pushConsentingToDestructive()", () => {
  it("never forces a push that applies without asking", async () => {
    const push = vi.fn(async (force: boolean) => (force ? "forced" : "applied"))
    expect(await pushConsentingToDestructive(push, policy, { interactive: () => true })).toBe("applied")
    expect(push.mock.calls).toEqual([[false]])
  })

  it("in a terminal names what would be lost, asks, and forces only on yes", async () => {
    const calls: boolean[] = []
    const push = vi.fn(async (force: boolean) => {
      calls.push(force)
      if (!force) throw refusal()
      return "forced"
    })
    const ask = vi.fn(async () => true)
    const result = await pushConsentingToDestructive(push, policy, {
      ask,
      interactive: () => true,
      describe: async () => ["Drop column: member.name"],
    })
    expect(result).toBe("forced")
    expect(calls).toEqual([false, true])
    expect(ask).toHaveBeenCalledOnce()
    expect(lines.join("\n")).toContain("Drop column: member.name")
  })

  it("in a terminal applies nothing on no, and says how to apply it on purpose", async () => {
    const push = vi.fn(async () => {
      throw refusal()
    })
    await expect(
      pushConsentingToDestructive(push, policy, { ask: async () => false, interactive: () => true }),
    ).rejects.toBeInstanceOf(DestructiveChangeRefused)
    expect(push).toHaveBeenCalledOnce()
  })

  it("without a terminal refuses with the engine's message and the command that applies it", async () => {
    const ask = vi.fn(async () => true)
    const push = vi.fn(async () => {
      throw refusal()
    })
    const err = await pushConsentingToDestructive(push, policy, { ask, interactive: () => false }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(DestructiveChangeRefused)
    const message = (err as Error).message
    expect(message).toContain("1 destructive operation(s) detected")
    expect(message).toContain("supatype push --yes")
    expect(message).toContain(DESTRUCTIVE_CHANGE_HINT)
    expect(ask).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledOnce()
  })

  it("forces with --yes, which is consent given up front", async () => {
    const push = vi.fn(async (force: boolean) => {
      if (!force) throw refusal()
      return "forced"
    })
    expect(await pushConsentingToDestructive(push, { ...policy, yes: true }, { interactive: () => false })).toBe("forced")
  })

  it("rethrows any other failure untouched", async () => {
    const boom = new Error("connection refused")
    await expect(
      pushConsentingToDestructive(async () => Promise.reject(boom), policy, { interactive: () => true }),
    ).rejects.toBe(boom)
  })

  it("still asks when the list of what would be lost cannot be read", async () => {
    const push = vi.fn(async (force: boolean) => {
      if (!force) throw refusal()
      return "forced"
    })
    const result = await pushConsentingToDestructive(push, policy, {
      ask: async () => true,
      interactive: () => true,
      describe: async () => Promise.reject(new Error("diff failed")),
    })
    expect(result).toBe("forced")
  })
})
