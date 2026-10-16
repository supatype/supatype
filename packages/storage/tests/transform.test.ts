/**
 * A transform of bytes that are not an image is the caller's mistake, not the server's.
 *
 * `transformImage` handed whatever was stored straight to sharp, and sharp throws on an empty or
 * undecodable buffer. Nothing caught it below the server's last-resort handler, so a 0-byte
 * `avatar.jpg` (stored as `image/jpeg`, which is all the upload declared) answered every
 * `?width=` request with a 500 and logged "Unhandled error: Input Buffer is empty".
 *
 * Supabase answers the same request 400, "The source image is invalid or unsupported for
 * rendering". The error type here is what lets the route answer that instead.
 */
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { transformImage, UnrenderableImageError } from "../src/transform.js"

const OPTS = { width: 16, height: 16, format: "webp" as const }

describe("transformImage", () => {
  it("refuses an empty buffer as unrenderable, not with sharp's own error", async () => {
    await expect(transformImage(Buffer.alloc(0), OPTS)).rejects.toBeInstanceOf(UnrenderableImageError)
  })

  it("refuses bytes that are not an image as unrenderable", async () => {
    await expect(transformImage(Buffer.from("plain text, not a jpeg"), OPTS)).rejects.toBeInstanceOf(
      UnrenderableImageError,
    )
  })

  it("still transforms a real image", async () => {
    const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#2a7" } }).jpeg().toBuffer()
    const out = await transformImage(jpeg, OPTS)
    expect(out.contentType).toBe("image/webp")
    expect((await sharp(out.buffer).metadata()).width).toBe(16)
  })
})
