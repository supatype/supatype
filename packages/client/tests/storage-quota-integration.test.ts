/**
 * Integration test — Task 93: Storage quota exceeded
 *
 * Tests: quota exceeded -> 507 with clear message.
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
  return new Blob([new Uint8Array(sizeBytes)])
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

describe("Task 93 — Storage quota integration", () => {
  beforeEach(() => vi.restoreAllMocks())

  describe("Quota exceeded on upload", () => {
    it("returns 507 Insufficient Storage with clear message", async () => {
      vi.stubGlobal("fetch", mockFetchResponse(507, {
        message: "Storage quota exceeded. Your project has used 100% of its 1GB storage allocation.",
        statusCode: 507,
        error: "Insufficient Storage",
      }, false))

      const client = freshClient()
      const blob = createMockBlob(10 * 1024 * 1024) // 10 MB
      const { data, error } = await client.from("uploads").upload("file.dat", blob)

      expect(data).toBeNull()
      expect(error).not.toBeNull()
      expect(error!.status).toBe(507)
      expect(error!.message).toContain("quota exceeded")
    })

    it("error message mentions the quota limit", async () => {
      vi.stubGlobal("fetch", mockFetchResponse(507, {
        message: "Storage quota exceeded. Your project has used 100% of its 1GB storage allocation. Upgrade your plan for more storage.",
      }, false))

      const client = freshClient()
      const { error } = await client.from("uploads").upload("big.zip", createMockBlob(1024))

      expect(error!.message).toContain("1GB")
      expect(error!.message).toContain("quota")
    })

    it("error message suggests upgrading plan", async () => {
      vi.stubGlobal("fetch", mockFetchResponse(507, {
        message: "Storage quota exceeded. Upgrade your plan for more storage.",
      }, false))

      const client = freshClient()
      const { error } = await client.from("uploads").upload("document.pdf", createMockBlob(1024))

      expect(error!.message).toContain("Upgrade")
    })
  })

  describe("Quota-aware upload flow", () => {
    it("succeeds when under quota", async () => {
      vi.stubGlobal("fetch", mockFetchResponse(200, { Key: "bucket/file.txt" }))

      const client = freshClient()
      const { data, error } = await client.from("bucket").upload("file.txt", createMockBlob(1024))

      expect(error).toBeNull()
      expect(data!.path).toBe("file.txt")
    })

    it("first upload succeeds, second hits quota", async () => {
      const fetchSpy = vi.fn()
        // First upload succeeds
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({ Key: "bucket/first.txt" }),
          headers: new Headers(),
        })
        // Second upload hits quota
        .mockResolvedValueOnce({
          ok: false,
          status: 507,
          json: vi.fn().mockResolvedValue({
            message: "Storage quota exceeded. Your project has used 100% of its 1GB storage allocation.",
          }),
          headers: new Headers(),
        })
      vi.stubGlobal("fetch", fetchSpy)

      const client = freshClient()

      const first = await client.from("bucket").upload("first.txt", createMockBlob(500 * 1024 * 1024))
      expect(first.error).toBeNull()

      const second = await client.from("bucket").upload("second.txt", createMockBlob(600 * 1024 * 1024))
      expect(second.data).toBeNull()
      expect(second.error!.status).toBe(507)
    })
  })

  describe("Quota error vs size limit error differentiation", () => {
    it("413 is file-level size limit, not quota", async () => {
      vi.stubGlobal("fetch", mockFetchResponse(413, {
        message: "Payload too large: file exceeds the maximum upload size of 50MB",
      }, false))

      const client = freshClient()
      const { error } = await client.from("bucket").upload("huge.bin", createMockBlob(100))

      expect(error!.status).toBe(413)
      expect(error!.message).toContain("too large")
    })

    it("507 is project-level quota, not file size", async () => {
      vi.stubGlobal("fetch", mockFetchResponse(507, {
        message: "Storage quota exceeded for project",
      }, false))

      const client = freshClient()
      const { error } = await client.from("bucket").upload("small.txt", createMockBlob(100))

      expect(error!.status).toBe(507)
      expect(error!.message).toContain("quota")
    })
  })

  describe("Quota on other storage operations", () => {
    it("list works normally even when quota is exceeded", async () => {
      vi.stubGlobal("fetch", mockFetchResponse(200, [
        { id: "1", name: "file1.txt", bucket_id: "bucket", created_at: "", updated_at: "", last_accessed_at: "" },
        { id: "2", name: "file2.txt", bucket_id: "bucket", created_at: "", updated_at: "", last_accessed_at: "" },
      ]))

      const client = freshClient()
      const { data, error } = await client.from("bucket").list()

      expect(error).toBeNull()
      expect(data).toHaveLength(2)
    })

    it("download works normally even when quota is exceeded", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(new Blob(["file content"])),
        headers: new Headers(),
      }))

      const client = freshClient()
      const { data, error } = await client.from("bucket").download("file.txt")

      expect(error).toBeNull()
      expect(data).not.toBeNull()
    })

    it("delete works normally even when quota is exceeded", async () => {
      vi.stubGlobal("fetch", mockFetchResponse(200, []))

      const client = freshClient()
      const { error } = await client.from("bucket").remove(["old-file.txt"])

      expect(error).toBeNull()
    })
  })
})
