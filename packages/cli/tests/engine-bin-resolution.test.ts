import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * A2-N2: a project whose `overrides.engine` path is missing must say so. It used to fall back to
 * whichever cached engine sorted last, so `doctor` answered with an engine nobody asked for.
 */
const state: { config: SupatypeProjectConfig | Error; hasConfig: boolean } = { config: new Error("unset"), hasConfig: true }

vi.mock("../src/config.js", () => ({
  hasProjectConfig: () => state.hasConfig,
  loadConfig: () => {
    if (state.config instanceof Error) throw state.config
    return state.config
  },
}))

let home: string
let cwd: string
const saved = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] }

async function cacheAnEngine(): Promise<string> {
  const { cachedBinaryPath, currentPlatform } = await import("../src/binary-cache.js")
  const bin = cachedBinaryPath("engine", "0.6.0", currentPlatform())
  mkdirSync(join(bin, ".."), { recursive: true })
  writeFileSync(bin, "not really an engine")
  // Also without `.exe`, the name the old cache scan looked for on every platform, so the fallback
  // this guards against is reachable on Windows too.
  writeFileSync(bin.replace(/\.exe$/, ""), "not really an engine")
  return bin
}

beforeEach(() => {
  vi.resetModules()
  state.hasConfig = true
  home = mkdtempSync(join(tmpdir(), "supatype-home-"))
  cwd = mkdtempSync(join(tmpdir(), "supatype-proj-"))
  process.env["HOME"] = home
  process.env["USERPROFILE"] = home
  vi.spyOn(process, "cwd").mockReturnValue(cwd)
})

afterEach(() => {
  vi.restoreAllMocks()
  process.env["HOME"] = saved.HOME
  process.env["USERPROFILE"] = saved.USERPROFILE
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

describe("engine binary resolution", () => {
  it("refuses a missing overrides.engine path instead of running a cached engine", async () => {
    await cacheAnEngine()
    const missing = join(cwd, "no-such-engine.exe")
    state.config = { project: { name: "p" }, overrides: { engine: missing } } as SupatypeProjectConfig
    const { engineBinPath } = await import("../src/engine-client.js")
    await expect(engineBinPath()).rejects.toThrow(/overrides\] engine path does not exist/)
  })

  it("uses a cached engine outside a project, where there is nothing else to go on", async () => {
    const bin = await cacheAnEngine()
    state.hasConfig = false
    state.config = new Error("No supatype.config.ts (or .js/.mjs) found in the current directory.")
    const { engineBinPath } = await import("../src/engine-client.js")
    expect(await engineBinPath()).toBe(bin)
  })

  it("does not hide a broken config behind a cached engine", async () => {
    await cacheAnEngine()
    state.config = new Error("supatype.config.ts: project.name is required")
    const { engineBinPath } = await import("../src/engine-client.js")
    await expect(engineBinPath()).rejects.toThrow(/project.name is required/)
  })
})
