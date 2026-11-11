import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { expectQuietBeforePassword } from "./support/quiet-sql.js"

/**
 * 0.9.2 release test round 5 (RB-1): `supatype dev` printed the db log after a retried push, and
 * `ALTER ROLE authenticator WITH LOGIN PASSWORD '<value>'` was in it and in `.supatype/ci-logs/`.
 * psql fills `:'pw'` in before sending, the image logs DDL in full, and `pg_stat_statements` keeps
 * the statement's text. Every session that sets a password now turns all three off first.
 */
const spawned = vi.hoisted(() => ({ inputs: [] as string[] }))
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (_cmd: string, _args: readonly string[], opts: { input?: string }) => {
    if (opts.input !== undefined) spawned.inputs.push(opts.input)
    return { status: 0, stdout: "", stderr: "", pid: 0, output: [], signal: null }
  },
}))

const { nativeRolesSql } = await import("../src/native-roles-sql.js")
const { requirePasswordAuth } = await import("../src/native-pg-auth.js")

describe("native dev's role script", () => {
  it.each([false, true])("is quiet before it sets authenticator's password (mask %s)", (withMask) => {
    expectQuietBeforePassword(nativeRolesSql(withMask))
  })
})

describe("native dev's superuser password", () => {
  let dataDir = ""
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "supatype-quiet-"))
    writeFileSync(join(dataDir, "pg_hba.conf"), "host all all 127.0.0.1/32 trust\n")
    spawned.inputs.length = 0
  })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  it("is set in a quiet session", () => {
    expect(requirePasswordAuth({ pgBinDir: dataDir, dataDir, port: 55299 }, "s3cret")).toBe(true)
    expect(spawned.inputs).toHaveLength(1)
    expectQuietBeforePassword(spawned.inputs[0]!)
  })
})
