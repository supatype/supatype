import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
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
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    spawnSync(join(CACHED_PG_BIN, "pg_ctl"), ["stop", "-D", join(dir, "data"), "-m", "immediate"], { stdio: "ignore" })
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Starts a cluster as dev does, then fails a later step while a SIGINT is on its way. */
async function interruptAfterPostgres(): Promise<{ code: number | null; out: string; dataDir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "supatype-start-pg-"))
  dirs.push(dir)
  const opts = { pgBinDir: CACHED_PG_BIN, dataDir: join(dir, "data"), port: await freePort(), logPath: join(dir, "pg.log") }
  const { code, out } = await runScriptInChild([
    `const shutdown = await import(${cliModule("dev-shutdown.ts")})`,
    `const pg = await import(${cliModule("postgres-ctl.ts")})`,
    `const opts = ${JSON.stringify(opts)}`,
    "shutdown.ensureDevShutdownHooks()",
    "const start = shutdown.stopQuietlyDuringStart(async () => {",
    "  pg.initdb(opts, 'pw')",
    "  pg.start(opts)",
    "  shutdown.pushStartUndoLast(() => pg.stop(opts, { quiet: true }))",
    "  setImmediate(() => process.emit('SIGINT'))",
    "  throw new Error('auth migrations failed')",
    "})",
    "try { await start() } catch (err) { console.error('✗ ' + err.message); process.exit(1) }",
  ])
  return { code, out, dataDir: opts.dataDir }
}

describe.skipIf(!existsSync(CACHED_PG_BIN))("Ctrl+C after native Postgres started", () => {
  it("stops Postgres, and says only that the start was stopped", async () => {
    const { code, out, dataDir } = await interruptAfterPostgres()
    expect(code).toBe(130)
    expect(out.split("\n").filter((line) => line.includes("[supatype]"))).toEqual(["[supatype] Stopped during start."])
    expect(existsSync(join(dataDir, "postmaster.pid"))).toBe(false)
    const status = spawnSync(join(CACHED_PG_BIN, "pg_ctl"), ["status", "-D", dataDir], { encoding: "utf8" })
    expect(status.stdout).toMatch(/no server running/)
  }, 90_000)
})
