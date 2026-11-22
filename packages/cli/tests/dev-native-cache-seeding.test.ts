import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { writeNativeAppliedAst } from "../src/commands/dev.js"

/**
 * S-24: native dev's schema watcher applied a schema that declared `.cache({ server: true })` and
 * left the cache allowlist off, so the declaration answered BYPASS until `supatype push` ran. Docker
 * dev and push switch it on after every apply; native dev now does too.
 */
const config: SupatypeProjectConfig = { project: { name: "acme" } }
const AST = { models: [{ name: "Post", fields: {}, annotations: { db: { tableName: "posts" }, platform: { cache: { enabled: true } } } }] }

let dir = ""
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-native-cache-"))
  mkdirSync(join(dir, ".supatype"), { recursive: true })
  writeFileSync(
    join(dir, ".supatype", "api-config.json"),
    JSON.stringify({ rest: { schema: "public", max_rows: 1000, cache_max_ttl: 60, cache_tables: {} }, graphql: { introspection: true } }),
  )
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("native dev after it applies a schema", () => {
  it("switches on the cache the schema declares", () => {
    writeNativeAppliedAst(dir, config, AST)
    const written = readFileSync(join(dir, ".supatype", "api-config.json"), "utf8")
    expect(written).toContain('"posts"')
    expect(written).toContain('"enabled": true')
  })
})
