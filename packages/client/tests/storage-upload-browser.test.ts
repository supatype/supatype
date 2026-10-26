/**
 * An upload from a browser file input sends the file's bytes, as the file's type, untouched.
 *
 * Found in manual testing: a profile picture uploaded from the kitchen-sink Account screen was
 * stored as 0 bytes. The cause was the file on disk (a 0-byte `test.jpg`), not the client, but the
 * browser path had no test: every upload test here sent a string or a Buffer from Node. These pin
 * what the browser path relies on, a `File` handed to `fetch` as the body, read by nothing first,
 * typed from `File.type` and carrying every byte.
 */
import { describe, expect, it } from "vitest"
import { StorageClient } from "../src/storage.js"
import type { RequestTransport } from "../src/fetch-with-retry.js"

const URL_BASE = "http://localhost:18473/storage/v1"
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9])

interface Sent {
  url: string
  method: string | undefined
  headers: Record<string, string>
  body: BodyInit | null | undefined
}

/** A transport that records the request and answers as the storage service does. */
function recording(): { transport: RequestTransport; sent: Sent[] } {
  const sent: Sent[] = []
  const transport: RequestTransport = async (url, init) => {
    sent.push({ url, method: init.method, headers: init.headers as Record<string, string>, body: init.body })
    return new Response(JSON.stringify({ Key: "speaker-headshots/avatars/a.jpg" }), { status: 200 })
  }
  return { transport, sent }
}

function bucket(transport: RequestTransport) {
  return new StorageClient(URL_BASE, () => Promise.resolve({ apikey: "anon" }), transport).from("speaker-headshots")
}

describe("BucketClient.upload with a browser File", () => {
  it("sends the File itself as the body, with every byte still in it", async () => {
    const { transport, sent } = recording()
    const file = new File([JPEG_BYTES], "avatar.jpg", { type: "image/jpeg" })

    const { error } = await bucket(transport).upload("avatars/a.jpg", file, { upsert: true })

    expect(error).toBeNull()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe("POST")
    expect(sent[0]!.url).toBe(`${URL_BASE}/object/speaker-headshots/avatars/a.jpg`)
    expect(sent[0]!.body).toBe(file)
    // What fetch would put on the wire for that body.
    const wire = new Uint8Array(await new Response(sent[0]!.body).arrayBuffer())
    expect(wire).toEqual(JPEG_BYTES)
  })

  it("types the request from File.type and keeps x-upsert", async () => {
    const { transport, sent } = recording()
    await bucket(transport).upload("avatars/a.jpg", new File([JPEG_BYTES], "a.jpg", { type: "image/jpeg" }), {
      upsert: true,
    })
    expect(sent[0]!.headers["Content-Type"]).toBe("image/jpeg")
    expect(sent[0]!.headers["x-upsert"]).toBe("true")
  })

  it("sends a Blob's bytes too, typed by the caller", async () => {
    const { transport, sent } = recording()
    const blob = new Blob([JPEG_BYTES], { type: "image/jpeg" })
    await bucket(transport).upload("avatars/b.jpg", blob, { contentType: "image/jpeg" })
    expect(sent[0]!.headers["Content-Type"]).toBe("image/jpeg")
    expect(new Uint8Array(await new Response(sent[0]!.body).arrayBuffer())).toEqual(JPEG_BYTES)
  })
})
