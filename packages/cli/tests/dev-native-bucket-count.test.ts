import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { provisionNativeBuckets } from "../src/commands/dev.js"
import { freePort, portOf } from "./support/ports.js"

/**
 * Local test round 3b: after a push with the storage service down, native dev printed
 * `Storage: provisioned 1 bucket(s).` and then `Storage API unreachable` for that bucket. The count
 * is of the buckets that are ready: written to buckets.json and, while the service runs, in it too.
 */
let storagePath: string

beforeEach(() => {
  storagePath = mkdtempSync(join(tmpdir(), "supatype-native-buckets-"))
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(storagePath, { recursive: true, force: true })
})

const printed = (): string[] => vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
const BUCKETS = [{ id: "avatars", public: false }]

describe("native dev's bucket provisioning", () => {
  it("counts no bucket the storage service did not take", async () => {
    const storageApi = { url: `http://127.0.0.1:${await freePort()}`, serviceRoleKey: "key" }
    await provisionNativeBuckets(BUCKETS, { storagePath, storageApi })
    expect(printed().filter((line) => line.includes("provisioned"))).toEqual([])
  })

  it("counts a bucket written to buckets.json while no service runs, as the service imports it when it starts", async () => {
    await provisionNativeBuckets(BUCKETS, { storagePath })
    expect(printed()).toContain("[supatype] Storage: provisioned 1 bucket(s).")
  })

  // 0.9.2: a project on S3 has no buckets.json, only the storage service on its bucket, and the
  // buckets its schema declares were never created there.
  it("creates the buckets in the storage service alone for a project on S3", async () => {
    const created: string[] = []
    const server = createServer((req, res) => {
      created.push(`${req.method ?? ""} ${req.url ?? ""}`)
      res.writeHead(200, { "content-type": "application/json" })
      res.end("{}")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      await provisionNativeBuckets(BUCKETS, { storageApi: { url: `http://127.0.0.1:${portOf(server)}`, serviceRoleKey: "key" } })
      expect(created).toEqual(["POST /bucket"])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
