import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * A preview with nothing to adopt agrees to adopt nothing. The engine binary reads no `--key` as
 * "adopt every conflict", so an empty key list goes to it as `--adopt-none` (see
 * `endpointToArgs`): one call, with no second preview first.
 */
const engineRequest = vi.hoisted(() => vi.fn())
vi.mock("../src/engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-client.js")>()),
  ensureEngine: vi.fn(async () => undefined),
  engineRequest,
}))

/** What the engine binary says it supports. */
const features = vi.hoisted(() => ({ value: new Set<string>(["adopt_keys", "adopt_none", "release", "reclaim"]) }))
vi.mock("../src/engine-ownership-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-ownership-gate.js")>()),
  engineCapabilities: vi.fn(async () => ({ features: features.value, source: "engine" })),
}))

const { targetSchemaAdopt } = await import("../src/resolve-target.js")
const { endpointToArgs } = await import("../src/engine-client.js")

const target = { mode: "direct", databaseUrl: "postgres://x" } as Parameters<typeof targetSchemaAdopt>[0]
const RELEASED = { status: "adopted", adopt: [], release: [{ kind: "table", table: "w", name: "w", message: "m" }] }

beforeEach(() => {
  engineRequest.mockReset()
  features.value = new Set(["adopt_keys", "adopt_none", "release", "reclaim"])
})

describe("targetSchemaAdopt() with an empty key list", () => {
  it("sends the empty list in one apply, which the binary gets as --adopt-none", async () => {
    engineRequest.mockResolvedValueOnce(RELEASED)
    await targetSchemaAdopt(target, {}, { yes: true, keys: [], release: ["table:w"] })
    expect(engineRequest).toHaveBeenCalledTimes(1)
    const body = engineRequest.mock.calls[0]?.[1] as Record<string, unknown>
    expect(body["yes"]).toBe(true)
    expect(body["keys"]).toEqual([])
    expect(endpointToArgs("/adopt", body, "req.json")).toContain("--adopt-none")
  })

  it("reclaims with --adopt-none in one apply", async () => {
    engineRequest.mockResolvedValueOnce(RELEASED)
    await targetSchemaAdopt(target, {}, { yes: true, keys: [], reclaim: ["table:w"] })
    expect(engineRequest).toHaveBeenCalledTimes(1)
    const body = engineRequest.mock.calls[0]?.[1] as Record<string, unknown>
    expect(body["reclaim"]).toEqual(["table:w"])
    expect(endpointToArgs("/adopt", body, "req.json").slice(-3)).toEqual(["--reclaim", "table:w", "--adopt-none"])
  })

  it("sends a non-empty key list straight to apply", async () => {
    engineRequest.mockResolvedValueOnce({ status: "adopted", adopt: [] })
    await targetSchemaAdopt(target, {}, { yes: true, keys: ["table:w"] })
    expect(engineRequest).toHaveBeenCalledTimes(1)
    expect(engineRequest.mock.calls[0]?.[1].keys).toEqual(["table:w"])
  })

  it("is refused, never sent, to an engine that would read it as every conflict", async () => {
    features.value = new Set(["adopt_keys", "release"])
    // A target of its own: what a target supports is asked once per target.
    const fresh = { ...target }
    await expect(targetSchemaAdopt(fresh, {}, { yes: true, keys: [], release: ["table:w"] })).rejects.toThrow(
      "does not support --adopt-none",
    )
    expect(engineRequest).not.toHaveBeenCalled()
  })
})

describe("the docker provider's adopt", () => {
  it("passes --adopt-none for an empty key list, never falling back to adopt-all", async () => {
    const { adoptCommand } = await import("../src/dev-compose.js")
    expect(adoptCommand(false)).toEqual(["adopt"])
    expect(adoptCommand(true)).toEqual(["adopt", "--yes"])
    expect(adoptCommand(true, [])).toEqual(["adopt", "--yes", "--adopt-none"])
    expect(adoptCommand(true, ["table:w", "column:w.c"])).toEqual(["adopt", "--yes", "--key", "table:w", "--key", "column:w.c"])
  })
})
