import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { rowCacheChangeNote, syncRowCacheEnv } from "../src/model-cache.js"

/**
 * Fresh-user test, cosmetic: the first `supatype dev` of a project with no row cache printed "Row
 * cache switched off in .env (pg_keyspace Mode B)." Nothing had been on, and the line said nothing a
 * new user could act on. Writing the initial "off" is now silent, and a real change says in plain
 * words what it means.
 */
let dir: string
const noRows = { models: [] }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-rowcache-"))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("row cache .env switch", () => {
  it("writes the initial off without reporting a change", () => {
    expect(syncRowCacheEnv(dir, noRows)).toBeNull()
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("SUPATYPE_KEYSPACE_ROWCACHE_DECODE=0")
  })

  it("reports turning it off when it was on", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_KEYSPACE_ROWCACHE_DECODE=1\nSUPATYPE_KEYSPACE_ROWCACHE_READTHROUGH=1\n")
    expect(syncRowCacheEnv(dir, noRows)).toBe("off")
  })

  it("explains the change in plain words, without internal names", () => {
    for (const state of ["on", "off"] as const) {
      const note = rowCacheChangeNote(state)
      expect(note).not.toContain("Mode B")
      expect(note).toContain("cache: { rows: true }")
    }
  })
})
