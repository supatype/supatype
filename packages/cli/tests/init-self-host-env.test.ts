import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"

/**
 * Fresh-user test C8: the self-host stack reads SUPATYPE_DB_PORT, SUPATYPE_SERVER_PORT and
 * SUPATYPE_SEAWEEDFS_PORT, and nothing a new project gets named them, so the first anyone heard of
 * them was a clash on 5432. The generated `.env` lists each with its default and says how to expose
 * them, commented out so the defaults still apply.
 */
let dir: string

beforeEach(() => {
  dir = join(tmpdir(), `dt-init-selfhost-env-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("init .env self-host ports", () => {
  it("lists every self-host port variable and the publish address, commented out", () => {
    scaffold(dir, defaultScaffoldOptions("ports-app"))
    const env = readFileSync(join(dir, ".env"), "utf8")
    expect(env).toMatch(/^# SUPATYPE_PUBLISH_ADDRESS=127\.0\.0\.1$/m)
    expect(env).toMatch(/^# SUPATYPE_DB_PORT=5432$/m)
    expect(env).toMatch(/^# SUPATYPE_SERVER_PORT=9999$/m)
    expect(env).toMatch(/^# SUPATYPE_SEAWEEDFS_PORT=8333$/m)
    expect(env).toContain("0.0.0.0")
  })
})
