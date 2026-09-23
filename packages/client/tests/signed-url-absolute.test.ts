/**
 * A signed URL has to be a URL.
 *
 * `getPublicUrl` returns something fetchable; `createSignedUrl` used to return the storage API's
 * response verbatim, and the API answers with a path (`/object/sign/<bucket>/<key>?token=…`). So
 * one of the two URL methods returned a URL and the other returned half of one.
 *
 * The failure lands nowhere near the cause: the caller passes it to `fetch` and gets
 * `TypeError: Failed to parse URL` with `ERR_INVALID_URL`, naming the path but not the method that
 * produced it. Found by running the kitchen-sink example's own verification against a live stack,
 * where it took out the whole private-bucket section after the signing itself had succeeded.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { StorageClient } from "../src/storage.js"

const STORAGE_URL = "http://localhost:18473/storage/v1"
const HEADERS = { apikey: "test-anon-key", Authorization: "Bearer test-token" }
const RELATIVE = "/object/sign/ticket-files/verify/1.pdf?token=abc.def"

function client(url = STORAGE_URL): StorageClient {
  return new StorageClient(url, () => Promise.resolve(HEADERS))
}

function respondWith(signedURL: string): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ signedURL }),
  }) as unknown as typeof fetch
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("createSignedUrl", () => {
  it("returns a URL that can be parsed, not the server's path", async () => {
    respondWith(RELATIVE)
    const { data, error } = await client().from("ticket-files").createSignedUrl("verify/1.pdf", 60)

    expect(error).toBeNull()
    // The assertion that matters: `new URL` is what the caller's fetch does.
    expect(() => new URL(data!.signedUrl)).not.toThrow()
    expect(data!.signedUrl).toBe(`${STORAGE_URL}${RELATIVE}`)
  })

  it("keeps the token and path intact while making it absolute", async () => {
    respondWith(RELATIVE)
    const { data } = await client().from("ticket-files").createSignedUrl("verify/1.pdf", 60)
    const parsed = new URL(data!.signedUrl)

    expect(parsed.pathname).toBe("/storage/v1/object/sign/ticket-files/verify/1.pdf")
    expect(parsed.searchParams.get("token")).toBe("abc.def")
  })

  it("passes an already-absolute answer through untouched", async () => {
    // A deployment fronted by a CDN, or one signing straight to S3, answers with a full URL.
    // Prefixing that a second time would produce a URL that parses and does not resolve.
    const absolute = "https://cdn.example.com/signed/1.pdf?token=abc"
    respondWith(absolute)
    const { data } = await client().from("ticket-files").createSignedUrl("verify/1.pdf", 60)

    expect(data!.signedUrl).toBe(absolute)
  })

  it("does not double the slash when the base URL has a trailing one", async () => {
    respondWith(RELATIVE)
    const { data } = await client(`${STORAGE_URL}/`).from("ticket-files").createSignedUrl("verify/1.pdf", 60)

    expect(data!.signedUrl).toBe(`${STORAGE_URL}${RELATIVE}`)
    expect(data!.signedUrl).not.toContain("v1//object")
  })

  it("is consistent with getPublicUrl, which was always absolute", async () => {
    respondWith(RELATIVE)
    const bucket = client().from("ticket-files")
    const publicUrl = bucket.getPublicUrl("verify/1.pdf").data.publicUrl
    const { data } = await bucket.createSignedUrl("verify/1.pdf", 60)

    expect(() => new URL(publicUrl)).not.toThrow()
    expect(new URL(data!.signedUrl).origin).toBe(new URL(publicUrl).origin)
  })
})
