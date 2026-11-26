import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PgCtlSpawn } from "../src/postgres-ctl.js"
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
    const fake = vi.fn<PgCtlSpawn>().mockReturnValue({ status: 0 })
    vi.spyOn(process.stdout, "write").mockReturnValue(true)
    runPgCtlStart({ pgBinDir: dir, dataDir: dir, port: 0 }, ["start"], join(dir, "pg.log"), fake)
    const stdio = fake.mock.calls[0]?.[2]?.stdio
    expect(Array.isArray(stdio)).toBe(true)
    if (!Array.isArray(stdio)) return
    expect(stdio[1]).toEqual(expect.any(Number))
    expect(stdio[2]).toEqual(expect.any(Number))
  })
})
