import { afterEach, describe, expect, it, vi } from "vitest"
import { probeCapabilities, type Capabilities, type EngineProbe } from "../src/engine-ownership-gate.js"

/**
 * C03 and A6-N2: what an engine or a server supports is asked once and remembered, so a probe that
 * failed for a reason of its own (an image Docker could not pull yet, a wrong project) used to be
 * remembered as "supports nothing" and every later push in the session was told to update.
 */

const PULL_FAILED =
  'Error response from daemon: failed to resolve reference "docker.io/supatype/schema-engine:late": not found'
const ALL = ["adopt_keys", "adopt_none", "release", "reclaim", "rebaseline", "accept_access_drift", "overwrite_drift", "engine_busy", "identity_columns"]

describe("probeCapabilities() when the engine never ran", () => {
  it("throws what went wrong instead of answering that it supports nothing", () => {
    const probe: EngineProbe = () => ({ status: 125, stdout: "", stderr: PULL_FAILED })
    expect(() => probeCapabilities(probe)).toThrow(/failed to resolve reference/)
  })
})

describe("rememberCapabilities(): only an answer is remembered, and only for a while", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("asks again after a failed probe, then remembers the answer until it is stale", async () => {
    const { capabilitiesCache, rememberCapabilities, CAPABILITIES_TTL_MS } = await import("@supatype/shared")
    vi.useFakeTimers()
    const cache = capabilitiesCache<Capabilities>(CAPABILITIES_TTL_MS)
    let calls = 0
    const probe = async () => {
      calls++
      if (calls === 1) throw new Error(PULL_FAILED)
      return { features: new Set(ALL), source: "engine" as const }
    }
    await expect(rememberCapabilities(cache, "k", probe)).rejects.toThrow(/failed to resolve/)
    expect((await rememberCapabilities(cache, "k", probe)).features.has("identity_columns")).toBe(true)
    await rememberCapabilities(cache, "k", probe)
    expect(calls).toBe(2)
    vi.advanceTimersByTime(CAPABILITIES_TTL_MS + 1)
    await rememberCapabilities(cache, "k", probe)
    expect(calls).toBe(3)
  })
})

describe("targetCapabilities() against a server", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const target = (ref: string) => ({
    mode: "cloud" as const,
    environment: "production",
    projectRef: ref,
    apiBaseUrl: "http://cp.test",
    apiPrefix: "/api/v1" as const,
    token: "t",
    link: null,
  })
  const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json })

  it("a missing route is a server too old for the check: it supports none of the features", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(404, { error: "not_found", message: "Route not found" })))
    const { targetCapabilities } = await import("../src/resolve-target.js")
    const caps = await targetCapabilities(target("old-server"))
    expect(caps.features.size).toBe(0)
  })

  it("a project the server does not know is said as that, never as 'update it' (A6-N2)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(404, { error: "not_found", message: "Project not found" })))
    const { requireTargetFeatures } = await import("../src/resolve-target.js")
    const err = await requireTargetFeatures(target("my-slug"), [{ feature: "adopt_keys", flag: "--key" }]).catch((e: unknown) => e)
    expect(String(err)).toMatch(/project.*my-slug/i)
    expect(String(err)).not.toMatch(/does not support/)
  })

  it("a failed request is not remembered: the next call asks again", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(reply(200, { data: { features: ALL } }))
    vi.stubGlobal("fetch", fetchMock)
    const { targetCapabilities } = await import("../src/resolve-target.js")
    const t = target("flaky")
    await expect(targetCapabilities(t)).rejects.toThrow("fetch failed")
    expect((await targetCapabilities(t)).features.has("adopt_keys")).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe("an engine's answer is keyed on the engine, not on the time", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps an answer past any TTL when the cache has none: the key changes with the engine", async () => {
    const { capabilitiesCache, rememberCapabilitiesSync, CAPABILITIES_TTL_MS } = await import("@supatype/shared")
    vi.useFakeTimers()
    const cache = capabilitiesCache<Capabilities>()
    const probe = vi.fn(() => ({ features: new Set(ALL), source: "engine" as const }))
    rememberCapabilitiesSync(cache, "engine@1", probe)
    vi.advanceTimersByTime(CAPABILITIES_TTL_MS * 10)
    rememberCapabilitiesSync(cache, "engine@1", probe)
    expect(probe).toHaveBeenCalledTimes(1)
    rememberCapabilitiesSync(cache, "engine@2", probe)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("never remembers a binary that is not there", async () => {
    const { binaryCapabilities, EngineProbeFailed } = await import("../src/engine-ownership-gate.js")
    const missing = "D:/does/not/exist/supatype-engine.exe"
    expect(() => binaryCapabilities(missing)).toThrow(EngineProbeFailed)
    expect(() => binaryCapabilities(missing)).toThrow(EngineProbeFailed)
  })
})
