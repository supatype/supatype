import { describe, expect, it } from "vitest"
import { unpinnedImagesNote } from "../src/release-images.js"

/**
 * Round 1: Docker dev ran functions-worker and control-plane from `:latest` and nothing said so.
 * A released CLI runs the images of its own version; only a CLI built from source, which has no
 * version of its own published, falls back to `:latest` for the images built in this repository.
 * That is intended, and now it is said, once, naming the images it applies to.
 */
describe("unpinnedImagesNote", () => {
  it("names every in-repo image a source build runs from :latest", () => {
    const note = unpinnedImagesNote({}, "")
    expect(note).toBeDefined()
    for (const name of ["studio", "storage", "realtime", "functions-worker", "control-plane"]) {
      expect(note).toContain(name)
    }
    expect(note).toMatch(/:latest/)
  })

  it("leaves out an image .env or the shell names", () => {
    const note = unpinnedImagesNote({ SUPATYPE_FUNCTIONS_WORKER_IMAGE: "supatype/functions-worker:mine" }, "")
    expect(note).not.toContain("functions-worker")
    expect(note).toContain("control-plane")
  })

  it("says nothing for a released CLI, or when every image is named", () => {
    expect(unpinnedImagesNote({}, "0.7.0")).toBeUndefined()
    const named = {
      SUPATYPE_STUDIO_IMAGE: "a",
      SUPATYPE_STORAGE_IMAGE: "b",
      SUPATYPE_REALTIME_IMAGE: "c",
      SUPATYPE_FUNCTIONS_WORKER_IMAGE: "d",
      SUPATYPE_CONTROL_PLANE_IMAGE: "e",
    }
    expect(unpinnedImagesNote(named, "")).toBeUndefined()
  })
})
