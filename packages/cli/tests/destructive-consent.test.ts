import { afterEach, describe, expect, it, vi } from "vitest"
import { EngineError } from "../src/engine-client.js"
import { errorMessage } from "../src/error-message.js"
import type { RenameCandidate } from "../src/engine-client.js"

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

const { DESTRUCTIVE_CHANGE_HINT, PLAIN_DROP_HINT, DestructiveChangeRefused, pushConsentingToDestructive } = await import(
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
    const message = errorMessage(err)
    expect(message).toContain("1 destructive operation(s) detected")
    expect(message).toContain("supatype push --yes")
    expect(message).toContain(DESTRUCTIVE_CHANGE_HINT)
    expect(ask).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledOnce()
  })

  it("does not pass on the engine's advice to use --force, a flag push does not have", async () => {
    const push = vi.fn(async () => {
      throw refusal()
    })
    const err = await pushConsentingToDestructive(push, policy, { interactive: () => false }).catch((e: unknown) => e)
    const message = errorMessage(err)
    expect(message).not.toContain("--force")
    expect(message).toContain("1 destructive operation(s) detected.")
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

/**
 * Renames are declared, never guessed (D1). When the engine names a drop and an add that may be a
 * rename, a terminal is asked about that before "drop the data?", and a yes writes the declaration
 * through the writer it was given and pushes again, unforced.
 */
describe("the rename offer", () => {
  const candidate = { kind: "column" as const, table: "member", from: "name", to: "title" }

  /** A push the engine refuses until the declaration is written, then applies. */
  function declaringPush() {
    let declared = false
    const calls: boolean[] = []
    const push = vi.fn(async (force: boolean) => {
      calls.push(force)
      if (!declared && !force) throw refusal()
      return force ? "forced" : "renamed"
    })
    const writer = {
      write: vi.fn(async () => {
        declared = true
      }),
    }
    return { push, writer, calls }
  }

  it("on yes writes the declaration and pushes again without force", async () => {
    const { push, writer, calls } = declaringPush()
    const questions: string[] = []
    const result = await pushConsentingToDestructive(push, policy, {
      ask: async (question) => {
        questions.push(question)
        return true
      },
      interactive: () => true,
      renameCandidates: async () => [candidate],
      renameWriter: writer,
    })
    expect(result).toBe("renamed")
    expect(calls).toEqual([false, false])
    expect(writer.write).toHaveBeenCalledWith(candidate)
    expect(questions).toEqual(["Was member.name renamed to member.title? (recorded in supatype/renames.json)"])
  })

  it("on no falls through to the drop question, and writes nothing", async () => {
    const { push, writer, calls } = declaringPush()
    const answers = [false, true]
    const result = await pushConsentingToDestructive(push, policy, {
      ask: async () => answers.shift() ?? false,
      interactive: () => true,
      renameCandidates: async () => [candidate],
      renameWriter: writer,
    })
    expect(result).toBe("forced")
    expect(calls).toEqual([false, true])
    expect(writer.write).not.toHaveBeenCalled()
  })

  it("asks once per source: a second pairing of a column already declared is skipped", async () => {
    const { push, writer } = declaringPush()
    const ask = vi.fn(async () => true)
    await pushConsentingToDestructive(push, policy, {
      ask,
      interactive: () => true,
      renameCandidates: async () => [candidate, { ...candidate, to: "label" }],
      renameWriter: writer,
    })
    expect(writer.write).toHaveBeenCalledOnce()
    expect(ask).toHaveBeenCalledOnce()
  })

  it("offers nothing without a writer, and nothing without a terminal", async () => {
    const { push } = declaringPush()
    const ask = vi.fn(async () => false)
    const renameCandidates = vi.fn(async () => [candidate])
    await expect(
      pushConsentingToDestructive(push, policy, { ask, interactive: () => true, renameCandidates }),
    ).rejects.toBeInstanceOf(DestructiveChangeRefused)
    expect(ask.mock.calls).toEqual([["Apply it and lose that data?"]])

    const writer = { write: vi.fn(async () => undefined) }
    await expect(
      pushConsentingToDestructive(push, policy, {
        ask,
        interactive: () => false,
        renameCandidates,
        renameWriter: writer,
      }),
    ).rejects.toBeInstanceOf(DestructiveChangeRefused)
    expect(writer.write).not.toHaveBeenCalled()
  })

  it("asks about a table by its names", async () => {
    const { push, writer } = declaringPush()
    const questions: string[] = []
    await pushConsentingToDestructive(push, policy, {
      ask: async (question) => {
        questions.push(question)
        return true
      },
      interactive: () => true,
      renameCandidates: async () => [{ kind: "table" as const, table: "member", from: "member", to: "members" }],
      renameWriter: writer,
    })
    expect(questions).toEqual(["Was table member renamed to members? (recorded in supatype/renames.json)"])
  })

  it("without a terminal names the command that records each rename", async () => {
    const { push, writer } = declaringPush()
    const err = await pushConsentingToDestructive(push, policy, {
      interactive: () => false,
      renameCandidates: async () => [candidate, { kind: "table" as const, table: "team", from: "team", to: "teams" }],
      renameWriter: writer,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DestructiveChangeRefused)
    const message = errorMessage(err)
    expect(message).toContain("supatype rename member.name member.title")
    expect(message).toContain("supatype rename team teams")
    expect(writer.write).not.toHaveBeenCalled()
  })

  it("does not offer again when the push after a declaration is still refused", async () => {
    const push = vi.fn(async (force: boolean) => {
      if (!force) throw refusal()
      return "forced"
    })
    const writer = { write: vi.fn(async () => undefined) }
    const ask = vi.fn(async (_question: string) => true)
    expect(
      await pushConsentingToDestructive(push, policy, {
        ask,
        interactive: () => true,
        renameCandidates: async () => [candidate],
        renameWriter: writer,
      }),
    ).toBe("forced")
    expect(writer.write).toHaveBeenCalledOnce()
    expect(ask.mock.calls.map(([q]) => q)).toEqual([
      "Was member.name renamed to member.title? (recorded in supatype/renames.json)",
      "Apply it and lose that data?",
    ])
  })
})

/**
 * C10: every drop refusal began "If you renamed a field: ... this push would drop the column and its
 * data and add an empty one", though nothing was being added. The rename hint is for a drop the
 * engine pairs with an add in the same push; a plain drop is worded as one.
 */
describe("the drop refusal's wording", () => {
  const refuse = (renameCandidates: () => Promise<RenameCandidate[]>) =>
    pushConsentingToDestructive(
      async () => {
        throw refusal()
      },
      policy,
      { interactive: () => false, renameCandidates },
    ).catch((e: unknown) => errorMessage(e))

  it("says a plain drop deletes the data when nothing is added in the same push", async () => {
    const message = await refuse(async () => [])
    expect(message).not.toContain("If you renamed a field")
    expect(message).not.toContain("add an empty one")
    expect(message).toContain(PLAIN_DROP_HINT)
    expect(message).toContain("supatype push --yes")
  })

  it("keeps the rename hint when a column is added in the same push", async () => {
    const message = await refuse(async () => [{ kind: "column", table: "author", from: "bio", to: "about" }])
    expect(message).toContain(DESTRUCTIVE_CHANGE_HINT)
  })
})
