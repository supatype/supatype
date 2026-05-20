import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import * as binaryCache from "../src/binary-cache.js"
import { ensureBinary } from "../src/ensure-binary.js"

const TEST_VERSION = "9.9.9"

const config = (): SupatypeProjectConfig => ({
  project: { name: "test" },
  database: { provider: "native" },
  server: { mode: "dev" },
  app: { mode: "none" },
  versions: {
    engine: "0.4.2",
    server: "0.1.0",
    postgres: "17.2",
    deno: TEST_VERSION,
  },
})

beforeEach(() => {
  const dir = binaryCache.cachePath("deno", TEST_VERSION)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  const dir = binaryCache.cachePath("deno", TEST_VERSION)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("ensureBinary", () => {
  it("returns cached path without calling download", async () => {
    const platform = binaryCache.currentPlatform()
    const path = binaryCache.cachedBinaryPath("deno", TEST_VERSION, platform)
    writeFileSync(path, "stub", { mode: 0o755 })

    const downloadSpy = vi.spyOn(binaryCache, "download")
    const resolved = await ensureBinary("deno", config())
    expect(resolved).toBe(path)
    expect(downloadSpy).not.toHaveBeenCalled()
  })

  it("downloads on cache miss", async () => {
    const platform = binaryCache.currentPlatform()
    const expected = binaryCache.cachedBinaryPath("deno", TEST_VERSION, platform)
    const downloadSpy = vi.spyOn(binaryCache, "download").mockResolvedValue(expected)

    const path = await ensureBinary("deno", config())
    expect(path).toBe(expected)
    expect(downloadSpy).toHaveBeenCalledWith("deno", TEST_VERSION, platform)
  })
})
