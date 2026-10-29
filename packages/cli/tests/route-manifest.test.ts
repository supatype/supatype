import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { isJsonObject } from "@supatype/shared"
import { patchRouteManifest } from "../src/route-manifest.js"
import { parseJsonAs } from "./support/json.js"

describe("patchRouteManifest", () => {
  it("merges realtime fields into existing manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-manifest-"))
    const path = join(dir, "manifest.json")
    try {
      patchRouteManifest(path, { realtime_enabled: true, realtime_url: "http://127.0.0.1:4000" })
      const parsed = parseJsonAs(readFileSync(path, "utf8"), isJsonObject)
      expect(parsed).toMatchObject({
        realtime_enabled: true,
        realtime_url: "http://127.0.0.1:4000",
      })
      patchRouteManifest(path, { schema: "public" })
      const again = parseJsonAs(readFileSync(path, "utf8"), isJsonObject)
      expect(again).toMatchObject({
        schema: "public",
        realtime_enabled: true,
        realtime_url: "http://127.0.0.1:4000",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Every compose render and every native dev start patches the manifest. It was rewritten each time
  // though nothing in it changed. Written by hand here, so a rewrite shows as reformatting.
  it("leaves the file untouched when the patch changes no value", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-manifest-"))
    const path = join(dir, "manifest.json")
    const text = '{"schema":"public","functions_enabled":true}'
    try {
      writeFileSync(path, text, "utf8")
      patchRouteManifest(path, { functions_enabled: true, functions_worker_url: undefined })
      expect(readFileSync(path, "utf8")).toBe(text)
      patchRouteManifest(path, { functions_enabled: false })
      expect(parseJsonAs(readFileSync(path, "utf8"), isJsonObject)).toEqual({ schema: "public", functions_enabled: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("leaves a malformed manifest alone when asked to, and starts it again otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-manifest-"))
    const path = join(dir, "manifest.json")
    try {
      writeFileSync(path, "{ not json", "utf8")
      patchRouteManifest(path, { schema: "public" }, { keepMalformed: true })
      expect(readFileSync(path, "utf8")).toBe("{ not json")
      patchRouteManifest(path, { schema: "public" })
      expect(parseJsonAs(readFileSync(path, "utf8"), isJsonObject)).toEqual({ schema: "public" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
