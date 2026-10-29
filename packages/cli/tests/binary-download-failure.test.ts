import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { download } from "../src/binary-cache.js"

/**
 * Local test, `update` with no release key: the failed download left an empty
 * `~/.supatype/cache/realtime/0.7.0/` behind, and the missing key, which no retry can supply, was
 * tried three times over four seconds.
 */
let home = ""
let fetches = 0

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "supatype-download-home-"))
  fetches = 0
  // homedir() reads these, so the cache lands in the temp directory.
  vi.stubEnv("HOME", home)
  vi.stubEnv("USERPROFILE", home)
  vi.stubEnv("SUPATYPE_RELEASE_PUBLIC_KEY", "")
  vi.stubEnv("SUPATYPE_ALLOW_UNVERIFIED_DOWNLOADS", "")
  vi.stubGlobal("fetch", async () => {
    fetches += 1
    return new Response("0000  supatype-realtime-linux-amd64\n")
  })
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

describe("a download that cannot be verified", () => {
  it("fails at once, without retrying what no retry can fix", async () => {
    await expect(download("realtime", "9.9.9", { os: "linux", arch: "amd64" })).rejects.toThrow(/No minisign public key/)
    expect(fetches).toBe(1)
  }, 20_000)

  it("leaves no version folder behind", async () => {
    await expect(download("realtime", "9.9.9", { os: "linux", arch: "amd64" })).rejects.toThrow()
    expect(existsSync(join(home, ".supatype", "cache", "realtime", "9.9.9"))).toBe(false)
  }, 20_000)
})
