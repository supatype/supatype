import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { projectConfig } from "./support/project-config.js"
import { cachedBinaryPath, currentPlatform, resolveBinary, type Component } from "../src/binary-cache.js"
import { pinnedComponentVersion } from "../src/release-images.js"
import { binaryCapabilities } from "../src/engine-ownership-gate.js"

/**
 * The engine the gate checks is the one that will run, found without the network when it can be:
 * an override, the release this CLI pins, or, for a component it does not pin, a cached release when
 * `latest` cannot be looked up.
 */
let home: string
let cwd: string
const saved = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] }

function config(extra: Partial<SupatypeProjectConfig> = {}): SupatypeProjectConfig {
  return projectConfig({ project: { name: "offline" }, ...extra })
}

/** The engine version this CLI runs when the project pins none. */
const ENGINE_PIN = pinnedComponentVersion("engine")

function cache(component: Component, version: string): void {
  const path = cachedBinaryPath(component, version, currentPlatform())
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, "bin")
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
    // Windows spawns an extensionless path as `<path>.exe`, so the override is copied there and that
    // copy is what resolves.
    const resolved = process.platform === "win32" ? `${bin}.exe` : bin
    expect(await resolveBinary("engine", config({ overrides: { engine: bin } }))).toBe(resolved)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("uses the engine release this CLI pins, from the cache, without looking anything up", async () => {
    const platform = currentPlatform()
    for (const v of ["0.6.0", ENGINE_PIN, "99.0.0"]) cache("engine", v)
    expect(await resolveBinary("engine", config())).toBe(cachedBinaryPath("engine", ENGINE_PIN, platform))
    expect(fetch).not.toHaveBeenCalled()
  })

  it("asks for the pinned engine to be downloaded rather than running another cached one", async () => {
    cache("engine", "99.0.0")
    await expect(resolveBinary("engine", config())).rejects.toThrow(`engine v${ENGINE_PIN} not found in cache`)
  })

  it("uses the newest cached release of a component it does not pin when latest cannot be looked up", async () => {
    const platform = currentPlatform()
    for (const v of ["2.1.0", "2.10.0", "2.9.1"]) cache("deno", v)
    expect(await resolveBinary("deno", config())).toBe(cachedBinaryPath("deno", "2.10.0", platform))
  })

  it("says what to do when nothing is cached, rather than failing on fetch", async () => {
    await expect(resolveBinary("deno", config())).rejects.toThrow(
      /Could not look up the latest deno release \(fetch failed\), and no deno binary is cached\. .*overrides\.deno/,
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
