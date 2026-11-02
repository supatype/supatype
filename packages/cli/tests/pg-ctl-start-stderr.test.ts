import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { start } from "../src/postgres-ctl.js"
import { CACHED_PG_BIN as bin } from "./support/child-script.js"

/**
 * Local test round 3b: Ctrl+C during native dev's start made pg_ctl print `could not send stop
 * signal (PID: ...): No such process` straight to dev's terminal. pg_ctl's errors now go to a file
 * beside the log and into the error dev reports, which an interrupted start does not report.
 *
 * Runs the real pg_ctl from the cached native Postgres, skipped where there is none.
 */
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!existsSync(bin))("pg_ctl start's errors", () => {
  it("are in the error it throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-pgctl-"))
    dirs.push(dir)
    const missing = join(dir, "no-such-data")
    expect(() => start({ pgBinDir: bin, dataDir: missing, port: 1, logPath: join(dir, "postgres.log") })).toThrow(
      /pg_ctl start failed \(exit \d+\): .*no-such-data/s,
    )
  })
})
