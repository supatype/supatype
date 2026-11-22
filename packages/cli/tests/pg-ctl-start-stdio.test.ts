import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { spawnSync } from "node:child_process"
import { runPgCtlStart } from "../src/postgres-ctl.js"

/**
 * S-37: `supatype pg start | tee file` never returned. pg_ctl's stdout was this process's own, and
 * Postgres, which outlives pg_ctl, inherited it: the pipe stayed open for as long as Postgres ran.
 */
let dir = ""
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-pg-ctl-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("pg_ctl start", () => {
  it("gives pg_ctl files for its output, never this process's own stdout", () => {
    const seen: unknown[] = []
    const fake = ((_cmd: string, _args: readonly string[], options: { stdio: unknown }) => {
      seen.push(options.stdio)
      return { status: 0 }
    }) as unknown as typeof spawnSync
    vi.spyOn(process.stdout, "write").mockReturnValue(true)
    runPgCtlStart({ pgBinDir: dir } as Parameters<typeof runPgCtlStart>[0], ["start"], join(dir, "pg.log"), fake)
    const stdio = seen[0]
    expect(Array.isArray(stdio)).toBe(true)
    if (!Array.isArray(stdio)) return
    expect(stdio[1]).toEqual(expect.any(Number))
    expect(stdio[2]).toEqual(expect.any(Number))
  })
})
