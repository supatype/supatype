import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ensureCluster } from "../src/postgres-ctl.js"

/**
 * Native dev printed "Initialising Postgres data directory..." on every start, which read as the
 * cluster being made again. It never was: initdb returns at once when PG_VERSION is there. The
 * message now says which of the two happens.
 */
let dir = ""
let said: string[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-ensure-cluster-"))
  said = []
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("ensureCluster", () => {
  it("says an existing cluster is used, and leaves it as it was", () => {
    const dataDir = join(dir, "data")
    mkdirSync(dataDir)
    writeFileSync(join(dataDir, "PG_VERSION"), "17\n")
    writeFileSync(join(dataDir, "row"), "kept")
    // No initdb in this bin dir: running it would throw.
    ensureCluster({ pgBinDir: join(dir, "bin"), dataDir, port: 1 }, "pw")
    expect(said.join("\n")).not.toMatch(/Initialising/)
    expect(said.join("\n")).toMatch(/existing Postgres data directory/)
    expect(readFileSync(join(dataDir, "row"), "utf8")).toBe("kept")
  })

  it("says it is initialising a new one when there is none", () => {
    // initdb is missing here, so the call fails after saying what it was about to do.
    expect(() => ensureCluster({ pgBinDir: join(dir, "bin"), dataDir: join(dir, "new"), port: 1 }, "pw")).toThrow()
    expect(said.join("\n")).toMatch(/Initialising a new Postgres data directory/)
  })
})
