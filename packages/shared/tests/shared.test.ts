import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CAPABILITIES_TTL_MS,
  capabilitiesCache,
  engineBusySentence,
  isFunctionName,
  rememberCapabilities,
  rememberCapabilitiesSync,
} from "../src/index.js"

afterEach(() => {
  vi.useRealTimers()
})

describe("engineBusySentence()", () => {
  it("reads every wording the engine has used, without the log prefix", () => {
    const now = "another push, adopt, rebaseline or rollback is running on this database; try again. Nothing was applied."
    const before = "another push, adopt or rebaseline is running on this database; try again."
    expect(engineBusySentence(`2026-10-10 INFO x\nError: ${now}\nmore`)).toBe(now)
    expect(engineBusySentence(`Error: ${before}`)).toBe(before)
  })

  it("is undefined for any other failure", () => {
    expect(engineBusySentence("Error: relation does not exist")).toBeUndefined()
  })
})

describe("the capabilities cache", () => {
  it("remembers only an answer, and only for its TTL", async () => {
    vi.useFakeTimers()
    const cache = capabilitiesCache<string>(CAPABILITIES_TTL_MS)
    const probe = vi.fn<() => Promise<string>>()
    probe.mockRejectedValueOnce(new Error("unreachable")).mockResolvedValue("v1")
    await expect(rememberCapabilities(cache, "k", probe)).rejects.toThrow(/unreachable/)
    expect(await rememberCapabilities(cache, "k", probe)).toBe("v1")
    await rememberCapabilities(cache, "k", probe)
    expect(probe).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(CAPABILITIES_TTL_MS + 1)
    await rememberCapabilities(cache, "k", probe)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it("without a TTL, keeps an answer until the key changes", () => {
    vi.useFakeTimers()
    const cache = capabilitiesCache<number>()
    const probe = vi.fn(() => 1)
    rememberCapabilitiesSync(cache, "engine@1", probe)
    vi.advanceTimersByTime(CAPABILITIES_TTL_MS * 10)
    rememberCapabilitiesSync(cache, "engine@1", probe)
    expect(probe).toHaveBeenCalledOnce()
    rememberCapabilitiesSync(cache, "engine@2", probe)
    expect(probe).toHaveBeenCalledTimes(2)
  })
})

describe("isFunctionName()", () => {
  it("accepts what the control plane accepts", () => {
    for (const name of ["hello", "send-email", "send_email", "v2", "0day"]) expect(isFunctionName(name)).toBe(true)
  })

  it("refuses capitals, separators, dots and a leading - or _", () => {
    for (const name of ["sendEmail", "a/b", "a\\b", "..", ".hidden", "-x", "_x", "", "a b", "ä"]) {
      expect(isFunctionName(name)).toBe(false)
    }
    expect(isFunctionName(undefined)).toBe(false)
  })
})
