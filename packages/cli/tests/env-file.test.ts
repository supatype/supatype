import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { hasEnvValue, MANAGED_MARKER, readEnvFile, readEnvInt, readEnvValue, upsertEnvFile } from "../src/env-file.js"

/**
 * `.env` is a file operators edit by hand, and the CLI rewrites it on every compose run.
 *
 * Two defects motivated this: the rewrite rebuilt the file from its assignments alone, so every
 * comment and blank line vanished; and the image keys derivable from `versions` were deleted
 * unconditionally, so `SUPATYPE_REALTIME_IMAGE` could be overridden from `.env` and
 * `SUPATYPE_SERVER_IMAGE` could not. Same file, same shape, different rules, which is how an hour
 * goes into wondering why a locally built image is ignored.
 */
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-env-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (body: string) => writeFileSync(join(dir, ".env"), body, "utf8")
const read = () => readFileSync(join(dir, ".env"), "utf8")

describe("upsertEnvFile", () => {
  it("keeps comments, blank lines and order", () => {
    write(`# notes about this project
DATABASE_URL=postgres://me@host/db

# the image I built by hand
SUPATYPE_SERVER_IMAGE=my/server:local
JWT_SECRET=abc
`)
    upsertEnvFile(dir, { ANON_KEY: "new" })

    const after = read()
    expect(after).toContain("# notes about this project")
    expect(after).toContain("# the image I built by hand")
    expect(after).toContain("SUPATYPE_SERVER_IMAGE=my/server:local")
    // Order preserved, new keys appended.
    expect(after.indexOf("DATABASE_URL")).toBeLessThan(after.indexOf("JWT_SECRET"))
    expect(after.indexOf("JWT_SECRET")).toBeLessThan(after.indexOf("ANON_KEY"))
    expect(after).toMatch(/\n\n/)
  })

  it("updates a value in place rather than moving it to the end", () => {
    write("A=1\nB=2\nC=3\n")
    upsertEnvFile(dir, { B: "changed" })
    expect(read()).toBe("A=1\nB=changed\nC=3\n")
  })

  it("leaves a hand-written value alone when asked to clean up managed keys", () => {
    // The reported bug, exactly: an operator's image override survived for realtime and was deleted
    // for the server.
    write("SUPATYPE_SERVER_IMAGE=my/server:local\n")
    upsertEnvFile(dir, {}, { removeManaged: ["SUPATYPE_SERVER_IMAGE"] })
    expect(readEnvFile(dir)["SUPATYPE_SERVER_IMAGE"]).toBe("my/server:local")
  })

  it("does clean up a value it wrote itself", () => {
    // Otherwise removing a pin from config leaves a stale image reference that silently keeps
    // running the old version, the reason the deletion existed at all.
    upsertEnvFile(
      dir,
      { SUPATYPE_SERVER_IMAGE: "supatype/server:v1.2.3" },
      { managed: ["SUPATYPE_SERVER_IMAGE"] },
    )
    expect(read()).toContain(MANAGED_MARKER)

    upsertEnvFile(dir, {}, { removeManaged: ["SUPATYPE_SERVER_IMAGE"] })
    expect(readEnvFile(dir)["SUPATYPE_SERVER_IMAGE"]).toBeUndefined()
    // And no orphaned marker comment left behind.
    expect(read()).not.toContain(MANAGED_MARKER)
  })

  it("takes over a hand-written value when config starts pinning it, and marks it", () => {
    write("SUPATYPE_SERVER_IMAGE=my/server:local\n")
    upsertEnvFile(
      dir,
      { SUPATYPE_SERVER_IMAGE: "supatype/server:v2.0.0" },
      { managed: ["SUPATYPE_SERVER_IMAGE"] },
    )
    const after = read()
    expect(after).toContain("SUPATYPE_SERVER_IMAGE=supatype/server:v2.0.0")
    expect(after).toContain(MANAGED_MARKER)
    // So the next run can clean it up again.
    upsertEnvFile(dir, {}, { removeManaged: ["SUPATYPE_SERVER_IMAGE"] })
    expect(readEnvFile(dir)["SUPATYPE_SERVER_IMAGE"]).toBeUndefined()
  })

  it("removes outright when asked, whoever wrote it", () => {
    // For a seed secret being retired.
    write("SUPATYPE_ADMIN_PASSWORD=temporary\nJWT_SECRET=keep\n")
    upsertEnvFile(dir, {}, { remove: ["SUPATYPE_ADMIN_PASSWORD"] })
    expect(readEnvFile(dir)["SUPATYPE_ADMIN_PASSWORD"]).toBeUndefined()
    expect(readEnvFile(dir)["JWT_SECRET"]).toBe("keep")
  })

  it("still accepts the old array argument as an unconditional removal", () => {
    write("GONE=1\nSTAYS=2\n")
    upsertEnvFile(dir, {}, ["GONE"])
    expect(readEnvFile(dir)).toEqual({ STAYS: "2" })
  })

  it("creates the file when absent", () => {
    upsertEnvFile(dir, { A: "1" })
    expect(read()).toBe("A=1\n")
  })

  it("does not treat a commented-out assignment as a value", () => {
    // `# FOO=bar` is a note, not a setting, the old parser kept it as a key called "# FOO".
    write("# FOO=bar\nREAL=1\n")
    upsertEnvFile(dir, { REAL: "2" })
    expect(read()).toContain("# FOO=bar")
    expect(readEnvFile(dir)).toEqual({ REAL: "2" })
  })
})

describe("a .env saved with a byte order mark", () => {
  // Windows tools write one: PowerShell 5's `Set-Content -Encoding utf8`, Notepad's "UTF-8 with
  // BOM". The single-key readers matched `^KEY=` against the raw text, so the first key in such a
  // file was invisible to them while readEnvFile, which trims each line, still saw it. A native
  // project with SUPATYPE_DEV_DB_PORT first silently started Postgres on another port.
  beforeEach(() => {
    writeFileSync(join(dir, ".env"), "\uFEFFSUPATYPE_DEV_DB_PORT=55660\r\nOTHER=1\r\n")
  })

  it("still yields its first key to every reader", () => {
    expect(readEnvFile(dir)["SUPATYPE_DEV_DB_PORT"]).toBe("55660")
    expect(readEnvValue(dir, "SUPATYPE_DEV_DB_PORT", "")).toBe("55660")
    expect(hasEnvValue(dir, "SUPATYPE_DEV_DB_PORT")).toBe(true)
    expect(readEnvInt(dir, "SUPATYPE_DEV_DB_PORT")).toBe(55660)
  })
})
