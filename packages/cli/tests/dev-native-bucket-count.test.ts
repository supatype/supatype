import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { provisionNativeBuckets } from "../src/commands/dev.js"
import { freePort } from "./support/ports.js"

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

  it("counts a bucket written to buckets.json while no service runs, as the server's store serves it", async () => {
    await provisionNativeBuckets(BUCKETS, { storagePath })
    expect(printed()).toContain("[supatype] Storage: provisioned 1 bucket(s).")
  })
})
