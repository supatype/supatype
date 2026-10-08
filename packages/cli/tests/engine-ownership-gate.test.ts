import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ENGINE_MIN_FOR_OWNERSHIP,
  ownershipFlagRefusal,
  requireEngineForOwnershipFlag,
  resolvedEngineVersion,
} from "../src/engine-ownership-gate.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

function config(versions?: { engine?: string }, overrides?: { engine?: string }): SupatypeProjectConfig {
  return {
    project: { name: "app" },
    ...(versions !== undefined && { versions }),
    ...(overrides !== undefined && { overrides }),
  } as unknown as SupatypeProjectConfig
}

/** Resolves like the pin does, without the network: a test must never fetch latest. */
const fromPin = vi.fn(async (_component: string, c: SupatypeProjectConfig) => c.versions?.engine ?? "0.6.0")

describe("ownershipFlagRefusal()", () => {
  it("refuses an engine older than the ledger, naming the flag and the resolved version", () => {
    expect(ownershipFlagRefusal("--overwrite-drift", "0.6.0")).toBe(
      "`--overwrite-drift` needs Supatype engine 0.7.0 or newer (resolved: 0.6.0). Update or pin versions.engine.",
    )
  })

  it("lets the ledger's release and anything newer through, a pre-release included", () => {
    expect(ENGINE_MIN_FOR_OWNERSHIP).toBe("0.7.0")
    expect(ownershipFlagRefusal("--release", "0.7.0")).toBeUndefined()
    expect(ownershipFlagRefusal("--release", "0.7.0-rc.1")).toBeUndefined()
    expect(ownershipFlagRefusal("--release", "1.0.0")).toBeUndefined()
  })
})

describe("resolvedEngineVersion()", () => {
  it("is the pin, or latest when unpinned", async () => {
    expect(await resolvedEngineVersion(config({ engine: "0.7.2" }), fromPin)).toBe("0.7.2")
    expect(await resolvedEngineVersion(config(), fromPin)).toBe("0.6.0")
  })

  it("is unknown for a local build", async () => {
    expect(await resolvedEngineVersion(config({ engine: "local" }), fromPin)).toBeUndefined()
    expect(await resolvedEngineVersion(config(undefined, { engine: "./engine" }), fromPin)).toBeUndefined()
  })
})

describe("requireEngineForOwnershipFlag()", () => {
  afterEach(() => vi.restoreAllMocks())

  it("exits 1 with the refusal before the flag is sent to an older engine", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
    await expect(
      requireEngineForOwnershipFlag("--overwrite-drift", config({ engine: "0.6.0" }), fromPin),
    ).rejects.toThrow("exit 1")
    expect(exit).toHaveBeenCalledWith(1)
    expect(stderr.mock.calls.flat().join(" ")).toContain(
      "`--overwrite-drift` needs Supatype engine 0.7.0 or newer (resolved: 0.6.0)",
    )
  })

  it("does nothing for an engine that has the flag, or one whose version is unknown", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    await requireEngineForOwnershipFlag("--overwrite-drift", config({ engine: "0.7.0" }), fromPin)
    await requireEngineForOwnershipFlag("--overwrite-drift", config({ engine: "local" }), fromPin)
    expect(exit).not.toHaveBeenCalled()
  })
})
