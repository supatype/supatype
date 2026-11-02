import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { markPostgrestUnpacked, postgrestRuntimeRepairDue } from "../src/postgrest-release.js"

/**
 * Local test round 3: native dev unpacked the PostgREST zip on every start. The repair that
 * unpacks it again is for a cache an older CLI filled with the exe alone, and was decided by
 * looking for DLLs beside it; the 14.x zip carries none, so it was always due. Once per version.
 */
let cacheDir: string
let archivePath: string

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "supatype-postgrest-"))
  archivePath = join(cacheDir, "postgrest-v14.18-windows-x86-64.zip")
  writeFileSync(join(cacheDir, "postgrest.exe"), "exe")
  writeFileSync(archivePath, "zip")
})

afterEach(() => rmSync(cacheDir, { recursive: true, force: true }))

describe("the cached PostgREST's runtime repair", () => {
  it("is due once for an exe with no DLLs beside it, and not after it was unpacked", () => {
    expect(postgrestRuntimeRepairDue(cacheDir, archivePath)).toBe(true)
    markPostgrestUnpacked(cacheDir)
    expect(postgrestRuntimeRepairDue(cacheDir, archivePath)).toBe(false)
  })

  it("is not due without the archive to unpack", () => {
    rmSync(archivePath)
    expect(postgrestRuntimeRepairDue(cacheDir, archivePath)).toBe(false)
  })
})
