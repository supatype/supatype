import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { isJsonObject } from "@supatype/shared"
import { patchRouteManifest, recordNativeRoutes, serviceSwitch, switchServices } from "../src/route-manifest.js"
import { parseJsonAs } from "./support/json.js"

/** A manifest at a fresh path holding `content`, given to `run`, then removed. */
function withManifest(content: Record<string, unknown> | undefined, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "supatype-manifest-"))
  const path = join(dir, "manifest.json")
  try {
    if (content !== undefined) writeFileSync(path, JSON.stringify(content), "utf8")
    run(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const read = (path: string): Record<string, unknown> => parseJsonAs(readFileSync(path, "utf8"), isJsonObject)

// 0.9.2: every service is switched one way, `services.<name>.enabled`, as the server reads it.
// Realtime had `realtime_enabled`, storage an inverted `storage_disabled`, functions
// `functions_enabled`, each written by its own rule.
describe("switchServices", () => {
  it("switches each service in the services map, with the keys given beside it, in one write", () => {
    withManifest({ schema: "public" }, (path) => {
      switchServices(path, { realtime: true, storage: false }, { realtime_url: "http://127.0.0.1:4000" })
      expect(read(path)).toEqual({
        schema: "public",
        realtime_url: "http://127.0.0.1:4000",
        services: { realtime: { enabled: true }, storage: { enabled: false } },
      })
    })
  })

  it("leaves the services it is not given, and the rest of an entry, as they are", () => {
    withManifest({ services: { functions: { enabled: true }, realtime: { enabled: false, note: "kept" } } }, (path) => {
      switchServices(path, { realtime: true })
      expect(read(path)["services"]).toEqual({ functions: { enabled: true }, realtime: { enabled: true, note: "kept" } })
    })
  })

  it("drops a service's switch when told nothing, so the server's start value stands", () => {
    withManifest({ services: { storage: { enabled: false } } }, (path) => {
      switchServices(path, { storage: undefined })
      expect(read(path)).toEqual({})
    })
  })

  // Older CLIs and Cloud wrote the legacy keys. The server still reads them, but a services entry
  // wins, so one left beside it would only mislead whoever reads the file.
  it("drops the legacy key of each service it switches", () => {
    withManifest({ realtime_enabled: false, functions_enabled: false }, (path) => {
      switchServices(path, { realtime: true })
      expect(read(path)).toEqual({ functions_enabled: false, services: { realtime: { enabled: true } } })
    })
  })

  it("starts a services map that is not an object again", () => {
    withManifest({ services: "nonsense" }, (path) => {
      switchServices(path, { functions: true })
      expect(read(path)).toEqual({ services: { functions: { enabled: true } } })
    })
  })
})

describe("serviceSwitch", () => {
  it("reads the services map, then the legacy key, then says nothing", () => {
    expect(serviceSwitch({ services: { functions: { enabled: false } }, functions_enabled: true }, "functions")).toBe(false)
    expect(serviceSwitch({ functions_enabled: false }, "functions")).toBe(false)
    expect(serviceSwitch({ services: { functions: {} } }, "functions")).toBeUndefined()
    expect(serviceSwitch({ functions_enabled: "yes" }, "functions")).toBeUndefined()
    expect(serviceSwitch({}, "storage")).toBeUndefined()
  })
})

// 0.9.2 release test N-FF2: native storage switches itself off and on at the gateway. A switch left
// from an earlier run would switch off a storage service of the developer's own, which native dev
// does not start and so never switches back on.
describe("recordNativeRoutes", () => {
  it("drops an earlier run's storage switch along with the services' addresses, and switches functions", () => {
    withManifest({ schema: "public", storage_url: "http://storage:5000", services: { storage: { enabled: false } } }, (path) => {
      recordNativeRoutes(path, true)
      expect(read(path)).toEqual({ schema: "public", services: { functions: { enabled: true } } })
    })
  })
})

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
