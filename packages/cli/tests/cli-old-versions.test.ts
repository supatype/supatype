import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanOldCliVersions, OLD_VERSIONS_NOTICE_BYTES, oldCliVersions, oldVersionsNotice } from "../src/cli-old-versions.js"
import { cliCacheRoot } from "../src/cli-program-path.js"

/**
 * Programs the npm starter downloaded for other versions. Nothing deletes them by itself, since a
 * project still on one would download it again; the starter says when they add up, at most once a
 * day, and `supatype cache clean` removes them.
 */

const DAY = 24 * 60 * 60 * 1000
const MB = 1024 * 1024

let home = ""

/** A cached version holding one program of `bytes`, which truncate makes without writing them. */
function cacheVersion(version: string, bytes: number): string {
  const dir = join(cliCacheRoot(home), version)
  mkdirSync(dir, { recursive: true })
  const program = join(dir, "supatype")
  writeFileSync(program, "")
  truncateSync(program, bytes)
  return dir
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "supatype-old-versions-"))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe("oldCliVersions", () => {
  it("lists every version but the running one, with its size", () => {
    cacheVersion("0.8.0", 3 * MB)
    cacheVersion("0.9.0", 5 * MB)
    cacheVersion("1.0.0", 7 * MB)
    writeFileSync(join(cliCacheRoot(home), ".old-versions-checked"), "")
    const old = oldCliVersions("1.0.0", home).map(({ version, bytes }) => ({ version, bytes }))
    expect(old.sort((a, b) => a.version.localeCompare(b.version))).toEqual([
      { version: "0.8.0", bytes: 3 * MB },
      { version: "0.9.0", bytes: 5 * MB },
    ])
  })

  it("finds nothing before anything is cached", () => {
    expect(oldCliVersions("1.0.0", home)).toEqual([])
  })
})

describe("oldVersionsNotice", () => {
  const over = OLD_VERSIONS_NOTICE_BYTES / 2 + MB

  it("says how much the old versions use once they pass the limit", () => {
    cacheVersion("0.8.0", over)
    cacheVersion("0.9.0", over)
    cacheVersion("1.0.0", over)
    expect(oldVersionsNotice("1.0.0", Date.now(), home)).toBe(
      "[supatype] Old CLI versions are using 252.0 MB. Run `supatype cache clean` to remove them.",
    )
  })

  it("says nothing at or under the limit, counting only old versions", () => {
    cacheVersion("0.9.0", OLD_VERSIONS_NOTICE_BYTES)
    cacheVersion("1.0.0", OLD_VERSIONS_NOTICE_BYTES)
    expect(oldVersionsNotice("1.0.0", Date.now(), home)).toBeUndefined()
  })

  it("says it at most once a day", () => {
    cacheVersion("0.8.0", over)
    cacheVersion("0.9.0", over)
    cacheVersion("1.0.0", MB)
    const now = Date.now()
    expect(oldVersionsNotice("1.0.0", now, home)).toBeDefined()
    expect(oldVersionsNotice("1.0.0", now + DAY - 60_000, home)).toBeUndefined()
    expect(oldVersionsNotice("1.0.0", now + DAY + 60_000, home)).toBeDefined()
  })
})

describe("cleanOldCliVersions", () => {
  it("removes every old version and keeps the running one", () => {
    const old = cacheVersion("0.9.0", MB)
    const running = cacheVersion("1.0.0", MB)
    expect(cleanOldCliVersions("1.0.0", { dryRun: false, home }).removed.map((v) => v.version)).toEqual(["0.9.0"])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(running)).toBe(true)
  })

  it("removes only the version named, as `cache clean cli 0.8.0` does", () => {
    const named = cacheVersion("0.8.0", MB)
    const other = cacheVersion("0.9.0", MB)
    cacheVersion("1.0.0", MB)
    expect(cleanOldCliVersions("1.0.0", { dryRun: false, version: "0.8.0", home }).removed.map((v) => v.version)).toEqual(["0.8.0"])
    expect(existsSync(named)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  // A standalone build from source reports 0.0.0, so its own version cannot say which program runs.
  it("keeps the program this process runs from, whatever its version", () => {
    const runningDir = cacheVersion("0.8.0", MB)
    const originalExecPath = process.execPath
    process.execPath = join(runningDir, "supatype")
    try {
      expect(cleanOldCliVersions("0.0.0", { dryRun: false, home }).removed).toEqual([])
      expect(existsSync(runningDir)).toBe(true)
    } finally {
      process.execPath = originalExecPath
    }
  })

  // Another project's dev runs that version's program. Windows will not delete a running executable.
  it.skipIf(process.platform !== "win32")("keeps a version another project is running, and says so", async () => {
    const busy = cacheVersion("0.9.0", MB)
    copyFileSync(process.execPath, join(busy, "supatype.exe"))
    const running = spawn(join(busy, "supatype.exe"), ["-e", "setTimeout(() => {}, 5000)"])
    await new Promise((resolve) => running.once("spawn", resolve))
    try {
      const result = cleanOldCliVersions("1.0.0", { dryRun: false, home })
      expect(result.inUse.map((v) => v.version)).toEqual(["0.9.0"])
      expect(result.removed).toEqual([])
    } finally {
      running.kill()
      await new Promise((resolve) => running.once("exit", resolve))
    }
  })

  it("only lists them on a dry run", () => {
    const old = cacheVersion("0.9.0", MB)
    cacheVersion("1.0.0", MB)
    expect(cleanOldCliVersions("1.0.0", { dryRun: true, home }).removed.map((v) => v.version)).toEqual(["0.9.0"])
    expect(existsSync(old)).toBe(true)
  })
})
