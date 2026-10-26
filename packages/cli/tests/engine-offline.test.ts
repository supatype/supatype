import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { cachedBinaryPath, currentPlatform, resolveBinary } from "../src/binary-cache.js"
import { binaryCapabilities } from "../src/engine-ownership-gate.js"

/**
 * The engine the gate checks is the one that will run, found without the network when it can be:
 * an override, or a cached release when `latest` cannot be looked up.
 */
let home: string
let cwd: string
const saved = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] }

function config(extra: Partial<SupatypeProjectConfig> = {}): SupatypeProjectConfig {
  return { project: { name: "offline" }, ...extra } as SupatypeProjectConfig
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "supatype-home-"))
  cwd = mkdtempSync(join(tmpdir(), "supatype-proj-"))
  process.env["HOME"] = home
  process.env["USERPROFILE"] = home
  vi.spyOn(process, "cwd").mockReturnValue(cwd)
  // Offline: any lookup of `latest` fails the way fetch does without a network.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed") }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  process.env["HOME"] = saved.HOME
  process.env["USERPROFILE"] = saved.USERPROFILE
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

describe("resolveBinary() offline", () => {
  it("uses overrides.engine without looking anything up", async () => {
    const bin = join(cwd, "engine-build")
    writeFileSync(bin, "#!/bin/sh\n")
    expect(await resolveBinary("engine", config({ overrides: { engine: bin } } as Partial<SupatypeProjectConfig>))).toBe(bin)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("uses the newest cached release when latest cannot be looked up", async () => {
    const platform = currentPlatform()
    for (const v of ["0.6.0", "0.10.0", "0.9.1"]) {
      const path = cachedBinaryPath("engine", v, platform)
      mkdirSync(join(path, ".."), { recursive: true })
      writeFileSync(path, "bin")
    }
    expect(await resolveBinary("engine", config())).toBe(cachedBinaryPath("engine", "0.10.0", platform))
  })

  it("says what to do when nothing is cached, rather than failing on fetch", async () => {
    await expect(resolveBinary("engine", config())).rejects.toThrow(
      /Could not look up the latest engine release \(fetch failed\), and no engine binary is cached\. .*overrides\.engine/,
    )
  })
})

describe("binaryCapabilities()", () => {
  it.skipIf(process.platform === "win32")("asks the binary that will run, falling back to its version", () => {
    const bin = join(cwd, "old-engine")
    writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "supatype-engine 0.7.0"; exit 0; fi\nexit 2\n')
    chmodSync(bin, 0o755)
    const caps = binaryCapabilities(bin)
    expect(caps.features.has("overwrite_drift")).toBe(true)
    expect(caps.features.has("accept_access_drift")).toBe(false)

    const current = join(cwd, "new-engine")
    writeFileSync(current, '#!/bin/sh\nif [ "$1" = "capabilities" ]; then echo \'{"features":["accept_access_drift"]}\'; exit 0; fi\nexit 2\n')
    chmodSync(current, 0o755)
    expect([...binaryCapabilities(current).features]).toEqual(["accept_access_drift"])
  })
})
