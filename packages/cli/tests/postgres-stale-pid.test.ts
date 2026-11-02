import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { removeStalePidFile } from "../src/postgres-ctl.js"

/**
 * Local test round 3: Ctrl+C during native dev's start left `postmaster.pid` behind, and the next
 * start printed `pg_ctl: another server might be running`. A pid file naming no live process is
 * removed before the start; one whose process lives is left for pg_ctl and Postgres to judge.
 */
let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "supatype-pgdata-"))
})

afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

function writePidFile(pid: string): string {
  const path = join(dataDir, "postmaster.pid")
  writeFileSync(path, `${pid}\n${dataDir}\n1700000000\n54339\n`, "utf8")
  return path
}

describe("removeStalePidFile", () => {
  it("removes a pid file whose process is gone", () => {
    const path = writePidFile("4242")
    expect(removeStalePidFile(dataDir, () => false)).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it("leaves a pid file whose process is alive", () => {
    const path = writePidFile(String(process.pid))
    expect(removeStalePidFile(dataDir)).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  it("leaves a pid file it cannot read a pid from, and is quiet without one", () => {
    const path = writePidFile("not-a-pid")
    expect(removeStalePidFile(dataDir, () => false)).toBe(false)
    expect(existsSync(path)).toBe(true)
    rmSync(path)
    expect(removeStalePidFile(dataDir, () => false)).toBe(false)
  })
})
