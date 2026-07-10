import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { patchRouteManifest } from "../src/route-manifest.js"

describe("patchRouteManifest", () => {
  it("merges realtime fields into existing manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-manifest-"))
    const path = join(dir, "manifest.json")
    try {
      patchRouteManifest(path, { realtime_enabled: true, realtime_url: "http://127.0.0.1:4000" })
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
      expect(parsed).toMatchObject({
        realtime_enabled: true,
        realtime_url: "http://127.0.0.1:4000",
      })
      patchRouteManifest(path, { schema: "public" })
      const again = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
      expect(again).toMatchObject({
        schema: "public",
        realtime_enabled: true,
        realtime_url: "http://127.0.0.1:4000",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
