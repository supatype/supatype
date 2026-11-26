import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PlatformId } from "../src/binary-cache.js"

/**
 * FF-32: the first native `dev` on a clean home failed `Postgres 17.2.15 archive not found. Run:
 * supatype update`, though `dev` fetches the engine, server and PostgREST it is missing. The
 * Postgres archive is fetched the same way, and `update` is no longer a step a first run needs.
 */

const fetched: string[] = []
const extracted: string[] = []

vi.mock("../src/binary-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/binary-cache.js")>()),
  download: async (component: string, version: string) => {
    fetched.push(`${component} ${version}`)
    return { path: "", fetched: true }
  },
}))
vi.mock("../src/archive-extract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/archive-extract.js")>()),
  extractArchive: (archive: string) => extracted.push(archive),
}))

const { extractPostgresArchive } = await import("../src/commands/dev.js")

let cache = ""
beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "supatype-pg-cache-"))
})
afterEach(() => {
  fetched.length = 0
  extracted.length = 0
  rmSync(cache, { recursive: true, force: true })
})

describe("native dev with no Postgres archive on this machine", () => {
  it("downloads it rather than sending the user to `supatype update`", async () => {
    const platform: PlatformId = { os: "linux", arch: "amd64" }
    await extractPostgresArchive(cache, "17.2.15", platform, join(cache, "pg-17.2.15"))
    expect(fetched).toEqual(["postgres 17.2.15"])
  })

  it("uses the one already cached without a download", async () => {
    const platform: PlatformId = { os: "linux", arch: "amd64" }
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, "supatype-pg-17-linux-amd64.tar.gz"), "x")
    await extractPostgresArchive(cache, "17.2.15", platform, join(cache, "pg-17.2.15"))
    expect(fetched).toEqual([])
    expect(extracted).toHaveLength(1)
  })
})
