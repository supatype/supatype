import { afterEach, describe, expect, it, vi } from "vitest"
import {
  assertSupported,
  capabilityRefusal,
  ENGINE_MIN_FOR_OWNERSHIP,
  legacyFeatures,
  LEGACY_OWNERSHIP_FEATURES,
  OwnershipUnsupportedError,
  parseCapabilities,
  probeCapabilities,
  type Capabilities,
  type EngineProbe,
} from "../src/engine-ownership-gate.js"

const ALL = ["adopt_keys", "adopt_none", "release", "reclaim", "rebaseline", "accept_access_drift", "overwrite_drift", "engine_busy"]

/** An engine that answers `capabilities` and `--version` as given (null: exits non-zero). */
function engine(answers: { capabilities?: string | null; version?: string | null }): EngineProbe & { calls: string[][] } {
  const calls: string[][] = []
  const probe = ((args: readonly string[]) => {
    calls.push([...args])
    const out = args[0] === "capabilities" ? answers.capabilities : answers.version
    return out === null || out === undefined ? { status: 2, stdout: "" } : { status: 0, stdout: out }
  }) as EngineProbe & { calls: string[][] }
  probe.calls = calls
  return probe
}

describe("probeCapabilities()", () => {
  it("reads the engine's own `capabilities` answer, after any log lines", () => {
    const probe = engine({ capabilities: `starting\n${JSON.stringify({ features: ALL })}` })
    const caps = probeCapabilities(probe)
    expect([...caps.features].sort()).toEqual([...ALL].sort())
    expect(caps.source).toBe("engine")
    expect(probe.calls).toEqual([["capabilities"]])
  })

  it("falls back to the version for a binary from before the subcommand", () => {
    const ledger = probeCapabilities(engine({ capabilities: null, version: "supatype-engine 0.7.1" }))
    expect([...ledger.features].sort()).toEqual([...LEGACY_OWNERSHIP_FEATURES].sort())
    // Came with `capabilities`, so an engine without the subcommand cannot have them.
    expect(ledger.features.has("accept_access_drift")).toBe(false)
    expect(ledger.features.has("adopt_none")).toBe(false)

    const older = probeCapabilities(engine({ capabilities: null, version: "supatype-engine 0.6.0" }))
    expect(older.features.size).toBe(0)
  })

  it("supports nothing when the engine answers neither", () => {
    expect(probeCapabilities(engine({ capabilities: null, version: null })).features.size).toBe(0)
    expect(probeCapabilities(engine({ capabilities: "not json", version: null })).features.size).toBe(0)
  })
})

describe("legacyFeatures()", () => {
  it("is the ledger's flags from its first release on, a pre-release included", () => {
    expect(ENGINE_MIN_FOR_OWNERSHIP).toBe("0.7.0")
    expect(legacyFeatures("supatype-engine 0.7.0-rc.1").size).toBe(LEGACY_OWNERSHIP_FEATURES.length)
    expect(legacyFeatures("supatype-engine 1.2.3").has("rebaseline")).toBe(true)
    expect(legacyFeatures("supatype-engine 0.6.9").size).toBe(0)
    expect(legacyFeatures("garbage").size).toBe(0)
  })
})

describe("parseCapabilities()", () => {
  it("is the feature list, or undefined for anything else", () => {
    expect(parseCapabilities({ features: ["release", 3] })).toEqual(new Set(["release"]))
    expect(parseCapabilities({})).toBeUndefined()
    expect(parseCapabilities(null)).toBeUndefined()
  })
})

describe("capabilityRefusal() / assertSupported()", () => {
  const server: Capabilities = { features: new Set(["release"]), source: "server" }
  const binary: Capabilities = { features: new Set(), source: "engine" }

  it("says which flag the server cannot take and to update it", () => {
    expect(capabilityRefusal({ feature: "release", flag: "--release" }, server)).toBeUndefined()
    expect(capabilityRefusal({ feature: "reclaim", flag: "--reclaim" }, server)).toBe(
      "this server does not support --reclaim; update it",
    )
    expect(capabilityRefusal({ feature: "overwrite_drift", flag: "--overwrite-drift" }, binary)).toContain(
      "this Supatype engine does not support --overwrite-drift; update it",
    )
  })

  it("throws for the first need not covered, naming it", () => {
    expect(() => assertSupported(server, [{ feature: "release", flag: "--release" }])).not.toThrow()
    try {
      assertSupported(server, [
        { feature: "release", flag: "--release" },
        { feature: "adopt_none", flag: "--adopt-none" },
      ])
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(OwnershipUnsupportedError)
      expect((err as OwnershipUnsupportedError).need.feature).toBe("adopt_none")
      expect((err as Error).message).toBe("this server does not support --adopt-none; update it")
    }
  })
})

describe("targetSchemaPush() against a server", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function selfHost() {
    return {
      mode: "self-host" as const,
      environment: "prod",
      projectRef: "app",
      apiBaseUrl: "http://cp.test",
      apiPrefix: "/platform/v1" as const,
      token: "t",
      link: null,
    }
  }

  function reply(status: number, json: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => json }
  }

  it("refuses --overwrite-drift on a server without the capabilities route, and never sends the push", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/schema/capabilities") ? reply(404, { error: "not_found" }) : reply(200, { data: {} }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const { targetSchemaPush } = await import("../src/resolve-target.js")
    await expect(targetSchemaPush(selfHost(), {}, { overwriteDrift: true })).rejects.toThrow(
      "this server does not support --overwrite-drift; update it",
    )
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "http://cp.test/platform/v1/projects/app/schema/capabilities",
    ])
  })

  it("refuses when the server's engine does not list the feature", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, { data: { features: ["release"] } })),
    )
    const { targetSchemaPush } = await import("../src/resolve-target.js")
    await expect(targetSchemaPush(selfHost(), {}, { overwriteDrift: true })).rejects.toThrow(
      "this server does not support --overwrite-drift",
    )
  })

  it("sends overwrite_drift, the engine's own name, once the server supports it", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: { body?: string }) =>
      url.endsWith("/schema/capabilities") ? reply(200, { data: { features: ALL } }) : reply(200, { data: { status: "applied" } }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const { targetSchemaPush } = await import("../src/resolve-target.js")
    await targetSchemaPush(selfHost(), {}, { overwriteDrift: true })
    const push = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/schema/push"))!
    const body = JSON.parse(String(push[1]?.body)) as Record<string, unknown>
    expect(body["overwrite_drift"]).toBe(true)
    expect(body).not.toHaveProperty("overwriteDrift")
  })

  it("does not ask for capabilities when no ownership flag is sent", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) => reply(200, { data: { status: "applied" } }))
    vi.stubGlobal("fetch", fetchMock)
    const { targetSchemaPush } = await import("../src/resolve-target.js")
    await targetSchemaPush(selfHost(), {}, {})
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["http://cp.test/platform/v1/projects/app/schema/push"])
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty("overwrite_drift")
  })

  it("doctor --rebaseline --accept-access-drift sends accept_access_drift, and is refused where unsupported", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: { body?: string }) =>
      url.endsWith("/schema/capabilities")
        ? reply(200, { data: { features: ["rebaseline", "overwrite_drift"] } })
        : reply(200, { data: { missing: [], staleManaged: [], unmanagedDrift: [] } }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const { targetSchemaDoctor } = await import("../src/resolve-target.js")
    // A server whose engine predates the rename: rebaseline yes, accepting access drift no.
    await expect(targetSchemaDoctor(selfHost(), {}, { rebaseline: true, acceptAccessDrift: true })).rejects.toThrow(
      "this server does not support --accept-access-drift; update it",
    )
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/schema/doctor"))).toBe(false)

    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/schema/capabilities")
        ? reply(200, { data: { features: ALL } })
        : reply(200, { data: { missing: [], staleManaged: [], unmanagedDrift: [] } }),
    )
    await targetSchemaDoctor(selfHost(), {}, { rebaseline: true, acceptAccessDrift: true })
    const sent = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/schema/doctor"))!
    const body = JSON.parse(String(sent[1]?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ rebaseline: true, accept_access_drift: true })
    expect(body).not.toHaveProperty("overwrite_drift")
  })
})
