import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { stop, type PgOptions } from "../src/postgres-ctl.js"

/**
 * Local test: native dev's Ctrl+C printed `pg_ctl: PID file ".../postmaster.pid" does not exist`.
 * Ctrl+C reaches Postgres as well as dev, so Postgres has already shut itself down by the time dev
 * stops it, and pg_ctl's complaint about that went straight to the terminal. A stop that does fail
 * was just as silent to dev, which ignored the exit code.
 */
let dir = ""
let warnings: string[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-pg-stop-"))
  warnings = []
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A data directory, with a pid file when `running`, and a bin directory with no pg_ctl in it, so
 * an attempt to run one fails as a stop that cannot stop the server does.
 */
function cluster(running: boolean): PgOptions {
  const dataDir = join(dir, "data")
  mkdirSync(dataDir, { recursive: true })
  if (running) writeFileSync(join(dataDir, "postmaster.pid"), "12345\n")
  return { pgBinDir: join(dir, "bin"), dataDir, port: 1 }
}

describe("stop", () => {
  it("says nothing when Postgres has already stopped", () => {
    stop(cluster(false))
    expect(warnings).toEqual([])
  })

  it("says so when a running Postgres could not be stopped", () => {
    stop(cluster(true))
    expect(warnings.join("\n")).toMatch(/Could not stop Postgres/)
  })
})
