import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { initdb, type PgOptions } from "../src/postgres-ctl.js"
import { CACHED_PG_BIN, cliModule, runScriptInChild } from "./support/child-script.js"
import { freePort } from "./support/ports.js"

/**
 * Nic's decision on round 3b: Ctrl+C after native Postgres has started but before dev registered
 * its shutdown (during the auth migrations, say) left Postgres running. Its stop is recorded the
 * moment it starts, and an interrupted start still prints only one line.
 *
 * A real cluster from the cached native Postgres, in a process of its own as `dev` is; skipped
 * where there is no cache.
 */

/**
 * How long creating the cluster may take. `initdb` is setup, not what this proves, and it is the
 * slow part: 57 seconds of a 75-second run on a machine loaded as a full suite run loads it, where
 * the start, the interrupt and the stop took 7 together. In the test it used its 90 seconds and
 * failed; here it has a budget of its own, and the test keeps 90 for what it checks.
 */
const INITDB_TIMEOUT_MS = 240_000

let dir = ""
let opts: PgOptions & { logPath: string }

describe.skipIf(!existsSync(CACHED_PG_BIN))("Ctrl+C after native Postgres started", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "supatype-start-pg-"))
    opts = { pgBinDir: CACHED_PG_BIN, dataDir: join(dir, "data"), port: await freePort(), logPath: join(dir, "pg.log") }
    initdb(opts, "pw")
  }, INITDB_TIMEOUT_MS)

  afterAll(() => {
    if (dir === "") return
    spawnSync(join(CACHED_PG_BIN, "pg_ctl"), ["stop", "-D", opts.dataDir, "-m", "immediate"], { stdio: "ignore" })
    rmSync(dir, { recursive: true, force: true })
  })

  /** Starts the cluster as dev does, then fails a later step while a SIGINT is on its way. */
  async function interruptAfterPostgres(): Promise<{ code: number | null; out: string }> {
    return runScriptInChild([
      `const shutdown = await import(${cliModule("dev-shutdown.ts")})`,
      `const pg = await import(${cliModule("postgres-ctl.ts")})`,
      `const opts = ${JSON.stringify(opts)}`,
      "shutdown.ensureDevShutdownHooks()",
      "const start = shutdown.stopQuietlyDuringStart(async () => {",
      "  pg.start(opts)",
      "  shutdown.pushStartUndoLast(() => pg.stop(opts, { quiet: true }))",
      "  setImmediate(() => process.emit('SIGINT'))",
      "  throw new Error('auth migrations failed')",
      "})",
      "try { await start() } catch (err) { console.error('✗ ' + err.message); process.exit(1) }",
    ])
  }

  it("stops Postgres, and says only that the start was stopped", async () => {
    const { code, out } = await interruptAfterPostgres()
    expect(code).toBe(130)
    expect(out.split("\n").filter((line) => line.includes("[supatype]"))).toEqual(["[supatype] Stopped during start."])
    expect(existsSync(join(opts.dataDir, "postmaster.pid"))).toBe(false)
    const status = spawnSync(join(CACHED_PG_BIN, "pg_ctl"), ["status", "-D", opts.dataDir], { encoding: "utf8" })
    expect(status.stdout).toMatch(/no server running/)
  }, 90_000)
})
