/**
 * An object path goes into a URL one encoded segment at a time.
 *
 * The client interpolated the path as given, so a name holding `?` or `#` cut the URL short: the
 * server saw `a b/c` and a query or fragment it never asked for, and answered for another object
 * or none. The `/` between folders stays a `/`, since the server matches the path on it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { StorageClient } from "../src/storage.js"
import { fetchCall, fetchReturning } from "./support/fetch-mock.js"

const STORAGE_URL = "http://localhost:18473/storage/v1"
const NAME = "a b/c?d#e.png"
const ENCODED = "a%20b/c%3Fd%23e.png"

function bucket() {
  return new StorageClient(STORAGE_URL, () => Promise.resolve({})).from("docs")
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("object paths in storage URLs", () => {
  it("are encoded per segment in a public URL", () => {
    expect(bucket().getPublicUrl(NAME).data.publicUrl).toBe(`${STORAGE_URL}/object/public/docs/${ENCODED}`)
  })

  it("are encoded per segment when asking for a signed URL", async () => {
    const fetch = fetchReturning({ signedURL: `/object/sign/docs/${ENCODED}?token=t` })
    vi.stubGlobal("fetch", fetch)
    await bucket().createSignedUrl(NAME, 60)
    expect(fetchCall(fetch).url).toBe(`${STORAGE_URL}/object/sign/docs/${ENCODED}`)
  })

  it("are encoded per segment on upload and download", async () => {
    const fetch = fetchReturning({})
    vi.stubGlobal("fetch", fetch)
    await bucket().upload(NAME, new ArrayBuffer(1))
    await bucket().download(NAME)
    expect(fetchCall(fetch, 0).url).toBe(`${STORAGE_URL}/object/docs/${ENCODED}`)
    expect(fetchCall(fetch, 1).url).toBe(`${STORAGE_URL}/object/authenticated/docs/${ENCODED}`)
  })

  it("read back as the name they were built from", () => {
    const url = new URL(bucket().getPublicUrl(NAME).data.publicUrl)
    expect(url.search).toBe("")
    expect(url.hash).toBe("")
    expect(decodeURIComponent(url.pathname)).toBe(`/storage/v1/object/public/docs/${NAME}`)
  })
})
