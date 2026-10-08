import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * A preview with nothing to adopt agrees to adopt nothing. The engine binary reads no `--key` as
 * "adopt every conflict", so an empty key list must never reach an apply as it is.
 */
const engineRequest = vi.hoisted(() => vi.fn())
vi.mock("../src/engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-client.js")>()),
  ensureEngine: vi.fn(async () => undefined),
  engineRequest,
}))

const { targetSchemaAdopt } = await import("../src/resolve-target.js")
const { isStalePreview } = await import("../src/adopt-walkthrough.js")

const target = { mode: "direct", databaseUrl: "postgres://x" } as Parameters<typeof targetSchemaAdopt>[0]
const RELEASED = { status: "preview", adopt: [], release: [{ kind: "table", table: "w", name: "w", message: "m" }] }

beforeEach(() => engineRequest.mockReset())

describe("targetSchemaAdopt() with an empty key list", () => {
  it("makes no engine call when there is nothing to release either", async () => {
    const outcome = await targetSchemaAdopt(target, {}, { yes: true, keys: [] })
    expect(engineRequest).not.toHaveBeenCalled()
    expect(outcome.adopt).toEqual([])
  })

  it("releases after a fresh preview shows still nothing to adopt", async () => {
    engineRequest.mockResolvedValueOnce(RELEASED).mockResolvedValueOnce({ ...RELEASED, status: "adopted" })
    await targetSchemaAdopt(target, {}, { yes: true, keys: [], release: ["table:w"] })
    expect(engineRequest.mock.calls.map((call) => call[1].yes)).toEqual([false, true])
  })

  it("writes nothing, as a stale preview, when a conflict has appeared since", async () => {
    engineRequest.mockResolvedValueOnce({
      ...RELEASED,
      adopt: [{ kind: "table", table: "x", name: "x", message: "Table x will be Supatype's" }],
    })
    const err = await targetSchemaAdopt(target, {}, { yes: true, keys: [], release: ["table:w"] }).catch((e) => e)
    expect(isStalePreview(err)).toBe(true)
    expect(engineRequest.mock.calls.map((call) => call[1].yes)).toEqual([false])
  })

  it("sends a non-empty key list straight to apply", async () => {
    engineRequest.mockResolvedValueOnce({ status: "adopted", adopt: [] })
    await targetSchemaAdopt(target, {}, { yes: true, keys: ["table:w"] })
    expect(engineRequest).toHaveBeenCalledTimes(1)
    expect(engineRequest.mock.calls[0]?.[1].keys).toEqual(["table:w"])
  })
})
