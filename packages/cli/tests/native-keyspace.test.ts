import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import {
  firstFreePort,
  nativeKeyspaceLibraryPresent,
  nativeMaskLibraryPresent,
  pgServerOptions,
} from "../src/postgres-ctl.js"

/**
 * Native `supatype dev` starts one Postgres, and what that Postgres can do
 * depends on which libraries the downloaded archive happens to carry. An
 * archive from before pg_keyspace was bundled, and the Windows archive that
 * cannot carry it at all, are both ordinary states — and naming a library that
 * is not there stops the server starting, which turns a missing cache into no
 * database.
 */
const roots: string[] = []

function install(libs: string[], layout: "unix" | "windows" = "unix"): string {
  const root = mkdtempSync(join(tmpdir(), "supatype-pg-"))
  roots.push(root)
  const binDir = join(root, "bin")
  const libDir = layout === "unix" ? join(root, "lib") : join(root, "lib", "postgresql")
  mkdirSync(binDir, { recursive: true })
  mkdirSync(libDir, { recursive: true })
  for (const lib of libs) writeFileSync(join(libDir, lib), "")
  return binDir
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("which libraries the archive carries", () => {
  it("finds each library in both layouts", () => {
    for (const layout of ["unix", "windows"] as const) {
      const ext = layout === "unix" ? "so" : "dll"
      const both = install([`pg_keyspace.${ext}`, `supatype_mask.${ext}`], layout)
      expect(nativeKeyspaceLibraryPresent(both)).toBe(true)
      expect(nativeMaskLibraryPresent(both)).toBe(true)
    }
    expect(nativeKeyspaceLibraryPresent(install(["pg_keyspace.dylib"]))).toBe(true)
  })

  it("says no for an archive without them, and for no archive at all", () => {
    const bare = install([])
    expect(nativeKeyspaceLibraryPresent(bare)).toBe(false)
    expect(nativeMaskLibraryPresent(bare)).toBe(false)
    for (const absent of [null, undefined, ""]) {
      expect(nativeKeyspaceLibraryPresent(absent)).toBe(false)
    }
  })
})

describe("the options pg_ctl hands the server", () => {
  const opts = (pgBinDir: string, extra: Record<string, unknown> = {}) => ({
    pgBinDir,
    dataDir: "/tmp/data",
    port: 55432,
    ...extra,
  })

  it("preloads nothing an archive does not carry", () => {
    expect(pgServerOptions(opts(install([]), { keyspacePort: 6379 }))).toBe("-p 55432")
  })

  it("preloads the mask alone, as it did before the keyspace existed", () => {
    const o = pgServerOptions(opts(install(["supatype_mask.so"]), { keyspacePort: 6379 }))
    expect(o).toBe("-p 55432 -c shared_preload_libraries=supatype_mask")
  })

  // pg_keyspace refuses to serve when the mask loads before it, because RESP
  // would hand back rows the mask never rewrote. The order is the safety
  // property, not a style choice.
  it("loads pg_keyspace before the mask, so the mask stays outermost", () => {
    const o = pgServerOptions(opts(install(["pg_keyspace.so", "supatype_mask.so"]), { keyspacePort: 6379 }))
    expect(o).toContain("-c shared_preload_libraries=pg_keyspace,supatype_mask")
  })

  it("sizes the keyspace for a laptop and keeps it ephemeral", () => {
    const o = pgServerOptions(
      opts(install(["pg_keyspace.so"]), { keyspacePort: 6380, keyspaceDatabase: "acme" }),
    )
    expect(o).toContain("-c pg_keyspace.port=6380")
    expect(o).toContain("-c pg_keyspace.durability=ephemeral")
    expect(o).toContain("-c pg_keyspace.keys=50000")
    expect(o).toContain("-c pg_keyspace.ring_mb=8")
    expect(o).toContain("-c pg_keyspace.rowcache_mb=1")
    expect(o).toContain("-c pg_keyspace.database=acme")
  })

  // No port means the caller decided against RESP — an archive that has the
  // library is not a reason to serve on a port nobody chose.
  it("serves no keyspace without a port, even with the library present", () => {
    const o = pgServerOptions(opts(install(["pg_keyspace.so", "supatype_mask.so"])))
    expect(o).toBe("-p 55432 -c shared_preload_libraries=supatype_mask")
  })
})

describe("choosing the keyspace port", () => {
  it("takes the base port when it is free", async () => {
    await expect(firstFreePort(6390, 5)).resolves.toBe(6390)
  })

  // 6379 is the first port a developer's own Redis, or a sidecar left running
  // from a previous `supatype dev`, will be holding.
  it("steps past a port something else is holding", async () => {
    const held = createServer()
    await new Promise<void>((done) => held.listen(6391, "127.0.0.1", done))
    try {
      await expect(firstFreePort(6391, 5)).resolves.toBe(6392)
    } finally {
      await new Promise<void>((done) => held.close(() => done()))
    }
  })

  it("gives up rather than returning a port it could not get", async () => {
    const held = createServer()
    await new Promise<void>((done) => held.listen(6393, "127.0.0.1", done))
    try {
      await expect(firstFreePort(6393, 1)).resolves.toBeNull()
    } finally {
      await new Promise<void>((done) => held.close(() => done()))
    }
  })
})
