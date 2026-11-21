import { describe, expect, it } from "vitest"
import { devBuildInitNote } from "../src/release-images.js"

/**
 * FF-32: a CLI built from source reports the version in its package.json, and `init` pinned that
 * version and the scaffold's `supatype-prepare` script, which the published packages of that version
 * may not have, so the new project's install failed with nothing saying why.
 */
describe("devBuildInitNote", () => {
  const deps = { cli: "0.7.0", types: "0.7.0", client: "0.7.0" }

  it("says plainly that a source build's project depends on versions that may not be published", () => {
    const note = devBuildInitNote(deps, "")
    expect(note).toBeDefined()
    expect(note).toMatch(/dev build/i)
    expect(note).toContain("@supatype/cli ^0.7.0")
    expect(note).toContain("@supatype/client ^0.7.0")
    expect(note).toMatch(/may not be published/)
  })

  it("treats a -dev or -local version as a dev build too", () => {
    expect(devBuildInitNote(deps, "0.8.0-dev.3")).toBeDefined()
    expect(devBuildInitNote(deps, "0.8.0-local")).toBeDefined()
  })

  it("says nothing for a stamped release", () => {
    expect(devBuildInitNote(deps, "0.7.0")).toBeUndefined()
  })
})
