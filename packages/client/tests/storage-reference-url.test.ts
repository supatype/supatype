/**
 * An `ImageAsset` or `FileAsset` column stores a reference, not a URL.
 *
 * What lands in the column is what `storage.upload()` produced and where it went:
 * `{ bucket, path }`, plus `mimeType` and `size` when Studio wrote it. A URL is not stored because a
 * stored one goes stale and bakes in the host. Every app reading such a column therefore has to turn
 * the reference back into a URL, and the kitchen-sink app instead read a `url` field that is never
 * there, so every speaker photo rendered as initials.
 */

import { describe, it, expect } from "vitest"
import { StorageClient } from "../src/storage.js"

const STORAGE_URL = "http://localhost:18473/storage/v1"

function storage(): StorageClient {
  return new StorageClient(STORAGE_URL, () => Promise.resolve({}))
}

describe("storage.publicUrl(reference)", () => {
  it("builds the public object URL from the stored bucket and path", () => {
    const url = storage().publicUrl({ bucket: "speaker-headshots", path: "avatars/ada.jpg" })
    expect(url).toBe(`${STORAGE_URL}/object/public/speaker-headshots/avatars/ada.jpg`)
  })

  it("is the same URL the bucket client gives for that path", () => {
    const ref = { bucket: "speaker-headshots", path: "avatars/ada.jpg", mimeType: "image/jpeg", size: 812 }
    const transform = { width: 104, height: 104, resize: "cover", format: "webp" } as const
    expect(storage().publicUrl(ref, { transform })).toBe(
      storage().from(ref.bucket).getPublicUrl(ref.path, { transform }).data.publicUrl,
    )
  })

  it("asks for a transform on read when given one", () => {
    const url = storage().publicUrl(
      { bucket: "speaker-headshots", path: "avatars/ada.jpg" },
      { transform: { width: 52, height: 52, resize: "cover" } },
    )
    expect(url).toBe(`${STORAGE_URL}/object/public/speaker-headshots/avatars/ada.jpg?width=52&height=52&resize=cover`)
  })

  it("answers null for an empty column, so a caller can fall back without a check of its own", () => {
    expect(storage().publicUrl(null)).toBeNull()
    expect(storage().publicUrl(undefined)).toBeNull()
  })

  it("answers null for a reference missing its bucket or path rather than a URL to nothing", () => {
    expect(storage().publicUrl({ bucket: "", path: "avatars/ada.jpg" })).toBeNull()
    expect(storage().publicUrl({ bucket: "speaker-headshots", path: "" })).toBeNull()
  })
})
