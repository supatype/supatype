/**
 * Integration test — Task 92: File upload size limit
 *
 * Tests: upload exceeding limit -> 413 with clear message.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { StorageClient } from "../src/storage.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STORAGE_URL = "http://localhost:8000/storage/v1"
const HEADERS = { apikey: "test-anon-key", Authorization: "Bearer test-token" }

function freshClient(): StorageClient {
  return new StorageClient(STORAGE_URL, HEADERS)
}

function createMockBlob(sizeBytes: number): Blob {
  const data = new Uint8Array(sizeBytes)
  return new Blob([data])
}

function mockFetchResponse(
  status: number,
  body: unknown,
  ok?: boolean,
): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: ok ?? (status >= 200 && status < 300),
    status,
    json: vi.fn().mockResolvedValue(body),
    headers: new Headers(),
  })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Task 92 — File upload size limit integration", () => {
  beforeEach(() => vi.restoreAllMocks())

  describe("Upload within size limit", () => {
    it("succeeds for a small file", async () => {
      vi.stubGlobal("fetch", mockFetchResponse(200, { Key: "avatars/photo.png" }))

      const client = freshClient()
      const blob = createMockBlob(1024) // 1 KB
      const { data, error } = await client.from("avatars").upload("photo.png", blob)

      expect(error).toBeNull()
      expect(data).not.toBeNull()
      expect(data!.path).toBe("photo.png")
    })

    it("succeeds for a file at the boundary of the limit", async () => {
      vi.stubGlobal("fetch", mockFetchResponse(200, { Key: "docs/file.pdf" }))

      const client = freshClient()
      const blob = createMockBlob(50 * 1024 * 1024) // 50 MB — right at limit
      const { data, error } = await client.from("docs").upload("file.pdf", blob, {
        contentType: "application/pdf",
      })

      expect(error).toBeNull()
      expect(data).not.toBeNull()
    })
  })

  describe("Upload exceeding size limit", () => {
    it("returns 413 Payload Too Large with clear error message", async () => {
      vi.stubGlobal("fetch", mockFetchResponse(413, {
        message: "Payload too large: file exceeds the maximum upload size of 50MB",
        statusCode: 413,
        error: "Payload Too Large",
      }, false))

      const client = freshClient()
      const blob = createMockBlob(100 * 1024 * 1024) // 100 MB
      const { data, error } = await client.from("uploads").upload("large-video.mp4", blob)

      expect(data).toBeNull()
      expect(error).not.toBeNull()
      expect(error!.status).toBe(413)
      expect(error!.message).toContain("too large")
    })

    it("error message mentions the size limit", async () => {
      vi.stubGlobal("fetch", mockFetchResponse(413, {
        message: "Payload too large: file exceeds the maximum upload size of 50MB",
      }, false))

      const client = freshClient()
      const { error } = await client.from("uploads").upload("huge.zip", createMockBlob(200 * 1024 * 1024))

      expect(error!.message).toContain("50MB")
    })

    it("returns 413 for just-over-limit file", async () => {
      vi.stubGlobal("fetch", mockFetchResponse(413, {
        message: "Payload too large: file exceeds the maximum upload size of 50MB",
      }, false))

      const client = freshClient()
      const blob = createMockBlob(50 * 1024 * 1024 + 1) // 50 MB + 1 byte
      const { data, error } = await client.from("uploads").upload("slightly-too-big.dat", blob)

      expect(data).toBeNull()
      expect(error!.status).toBe(413)
    })
  })

  describe("Upload sends correct request", () => {
    it("sends POST to /object/{bucket}/{path}", async () => {
      const fetchSpy = mockFetchResponse(200, { Key: "bucket/file.txt" })
      vi.stubGlobal("fetch", fetchSpy)

      const client = freshClient()
      await client.from("bucket").upload("file.txt", createMockBlob(100))

      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${STORAGE_URL}/object/bucket/file.txt`)
      expect(opts.method).toBe("POST")
    })

    it("includes content-type header", async () => {
      const fetchSpy = mockFetchResponse(200, { Key: "images/pic.jpg" })
      vi.stubGlobal("fetch", fetchSpy)

      const client = freshClient()
      await client.from("images").upload("pic.jpg", createMockBlob(100), {
        contentType: "image/jpeg",
      })

      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect((opts.headers as Record<string, string>)["Content-Type"]).toBe("image/jpeg")
    })

    it("sends x-upsert header when upsert option is true", async () => {
      const fetchSpy = mockFetchResponse(200, { Key: "bucket/file.txt" })
      vi.stubGlobal("fetch", fetchSpy)

      const client = freshClient()
      await client.from("bucket").upload("file.txt", createMockBlob(100), { upsert: true })

      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect((opts.headers as Record<string, string>)["x-upsert"]).toBe("true")
    })
  })

  describe("Various error responses from storage", () => {
    it("handles 400 Bad Request", async () => {
      vi.stubGlobal("fetch", mockFetchResponse(400, {
        message: "Invalid file name",
      }, false))

      const client = freshClient()
      const { error } = await client.from("bucket").upload("", createMockBlob(100))

      expect(error!.status).toBe(400)
      expect(error!.message).toBe("Invalid file name")
    })

    it("handles 401 Unauthorized", async () => {
      vi.stubGlobal("fetch", mockFetchResponse(401, {
        message: "Unauthorized",
      }, false))

      const client = freshClient()
      const { error } = await client.from("private-bucket").upload("secret.doc", createMockBlob(100))

      expect(error!.status).toBe(401)
    })

    it("propagates network failure as thrown error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")))

      const client = freshClient()

      // StorageClient.upload does not wrap fetch errors — they propagate
      await expect(
        client.from("bucket").upload("file.txt", createMockBlob(100)),
      ).rejects.toThrow("Network error")
    })
  })
})
