import { beforeEach, describe, expect, it, vi } from "vitest"
import { directTarget } from "./support/deploy-target.js"

/**
 * A rollback the engine refuses reaches the person as the engine said it. The engine prints the
 * refusal as a JSON line on stdout and as `Error: <sentence>` on stderr after its log lines; the
 * CLI used to show `Engine /rollback failed (exit 1):` and the whole of stderr, so the sentence
 * saying why, and what to do instead, was buried.
 */
const engineRequest = vi.hoisted(() => vi.fn<(endpoint: string, body: Record<string, unknown>) => Promise<unknown>>())
vi.mock("../src/engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-client.js")>()),
  ensureEngine: vi.fn(async () => undefined),
  engineRequest,
}))

const { targetSchemaRollback } = await import("../src/resolve-target.js")
const { EngineError } = await import("../src/engine-client.js")

const SAID =
  "data_not_restorable: Migration push_2 dropped column public.posts.title, and the data it held cannot be " +
  "restored by undo. Nothing was rolled back. To get the data back, restore the database from a backup; " +
  "to change the schema from here, make a new forward change to it and push."

/** The error the engine binary's refusal comes back as, as `throwEngineFailure` builds it. */
function refusedByTheEngine(): InstanceType<typeof EngineError> {
  const line = { status: "refused", reason: "data_not_restorable", migration: "push_2", lost: ["column public.posts.title"], message: SAID }
  const stderr = `2026-10-17T20:00:00Z INFO supatype_engine: connecting\nError: ${SAID}`
  return new EngineError(`Engine /rollback failed (exit 1): ${stderr}`, "/rollback", 1, `${JSON.stringify(line)}\n`)
}

beforeEach(() => {
  engineRequest.mockReset()
})

describe("targetSchemaRollback() refused by the engine", () => {
  it("throws the engine's own sentence, with its reason", async () => {
    engineRequest.mockRejectedValueOnce(refusedByTheEngine())
    const err = await targetSchemaRollback(directTarget("postgres://x")).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EngineError)
    expect(err).toMatchObject({ message: SAID, reason: "data_not_restorable" })
  })

  it("passes any other failure on as it was", async () => {
    const failed = new EngineError("Engine /rollback failed (exit 1): boom", "/rollback", 1, "")
    engineRequest.mockRejectedValueOnce(failed)
    await expect(targetSchemaRollback(directTarget("postgres://x"))).rejects.toBe(failed)
  })
})
