import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import {
  firstFreePort,
  nativeKeyspaceLibraryPresent,
  nativeMaskLibraryPresent,
  pgServerOptions,
  pgSettingArg,
} from "../src/postgres-ctl.js"
import {
  nativeKeyspaceAddr,
  nativeKeyspacePort,
  writeKeyspacePasswordFile,
  type NativeKeyspaceChecks,
} from "../src/native-keyspace.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { projectConfig } from "./support/project-config.js"
import { freePort } from "./support/ports.js"

/**
 * Native `supatype dev` starts one Postgres, and what that Postgres can do
 * depends on which libraries the downloaded archive happens to carry. An
 * archive from before pg_keyspace was bundled, and the Windows archive that
 * cannot carry it at all, are both ordinary states, and naming a library that
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

  // Local test N3: native Postgres ran wal_level=replica, so realtime could not create its slot
  // and never ran, on any archive. A command-line setting beats postgresql.conf, so a cluster made
  // before this takes it at its next start, which every `supatype dev` is.
  it("runs with logical decoding, which realtime needs, whatever the archive carries", () => {
    for (const libs of [[], ["supatype_mask.so"], ["pg_keyspace.so", "supatype_mask.so"]]) {
      expect(pgServerOptions(opts(install(libs), { keyspacePort: 6379 }))).toContain("-c wal_level=logical")
    }
  })

  it("preloads nothing an archive does not carry", () => {
    expect(pgServerOptions(opts(install([]), { keyspacePort: 6379 }))).toBe(
      "-p 55432 -c wal_level=logical -c max_worker_processes=16",
    )
  })

  it("preloads the mask alone, as it did before the keyspace existed", () => {
    const o = pgServerOptions(opts(install(["supatype_mask.so"]), { keyspacePort: 6379 }))
    expect(o).toBe(
      "-p 55432 -c wal_level=logical -c max_worker_processes=16 -c shared_preload_libraries=supatype_mask",
    )
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

  // No port means the caller decided against RESP. An archive that has the
  // library is not a reason to serve on a port nobody chose.
  it("serves no keyspace without a port, even with the library present", () => {
    const o = pgServerOptions(opts(install(["pg_keyspace.so", "supatype_mask.so"])))
    expect(o).toBe(
      "-p 55432 -c wal_level=logical -c max_worker_processes=16 -c shared_preload_libraries=supatype_mask",
    )
  })

  // The native archives now carry pg_cron, pg_net, plan_filter and safeupdate as the Docker image
  // does, and each only works preloaded. Preloading one an archive lacks stops Postgres, so an older
  // archive has to start exactly as it did.
  const EVERY_LIBRARY = ["pg_keyspace", "pg_stat_statements", "pg_cron", "pg_net", "plan_filter", "safeupdate", "supatype_mask"]

  it("preloads every library the archive carries, in the image's order", () => {
    const o = pgServerOptions(
      opts(install(EVERY_LIBRARY.map((lib) => `${lib}.so`)), { keyspacePort: 6379, database: "acme" }),
    )
    expect(o).toContain(`-c shared_preload_libraries=${EVERY_LIBRARY.join(",")}`)
  })

  it("preloads only what an older archive carries", () => {
    const o = pgServerOptions(opts(install(["pg_stat_statements.so", "supatype_mask.so"]), { database: "acme" }))
    expect(o).toContain("-c shared_preload_libraries=pg_stat_statements,supatype_mask")
    expect(o).not.toMatch(/cron\.|pg_net\./)
  })

  it("points pg_cron and pg_net at the project's database", () => {
    const o = pgServerOptions(opts(install(["pg_cron.dll", "pg_net.dll"], "windows"), { database: "acme" }))
    expect(o).toContain("-c cron.database_name=acme")
    expect(o).toContain("-c cron.use_background_workers=on")
    expect(o).toContain("-c pg_net.database_name=acme")
    expect(o).toContain("-c pg_net.batch_size=200")
  })

  it("leaves room for the background workers, as the image does", () => {
    expect(pgServerOptions(opts(install([])))).toContain("-c max_worker_processes=16")
  })
})

// Each base is a port the system just handed out, never a fixed one: 6390 to 6393 were, and a
// developer's own dev stacks and Valkey sidecars (6379 upward) held them, so these failed on the
// machine they ran on rather than on the code.
describe("choosing the keyspace port", () => {
  /** Listens on `port` for the length of `body`. */
  async function holding<T>(port: number, body: () => Promise<T>): Promise<T> {
    const held = createServer()
    await new Promise<void>((done) => held.listen(port, "127.0.0.1", done))
    try {
      return await body()
    } finally {
      await new Promise<void>((done) => held.close(() => done()))
    }
  }

  it("takes the base port when it is free", async () => {
    const base = await freePort()
    await expect(firstFreePort(base, 5)).resolves.toBe(base)
  })

  // 6379 is the first port a developer's own Redis, or a sidecar left running
  // from a previous `supatype dev`, will be holding.
  it("steps past a port something else is holding", async () => {
    const base = await freePort()
    const chosen = await holding(base, () => firstFreePort(base, 5))
    expect(chosen).not.toBeNull()
    expect(chosen).toBeGreaterThan(base)
    expect(chosen).toBeLessThan(base + 5)
  })

  it("gives up rather than returning a port it could not get", async () => {
    const base = await freePort()
    await expect(holding(base, () => firstFreePort(base, 1))).resolves.toBeNull()
  })
})

describe("whether native dev serves the keyspace from Postgres", () => {
  const project = (over: Partial<SupatypeProjectConfig>) =>
    projectConfig({ project: { name: "acme" }, database: { provider: "native" }, ...over })
  const pinned: Partial<SupatypeProjectConfig> = { versions: { postgres: "17.2" } }
  // The real filesystem check against a fake archive; only the port is stubbed.
  const checks: NativeKeyspaceChecks = {
    libraryPresent: nativeKeyspaceLibraryPresent,
    freePort: () => Promise.resolve(6379),
  }
  const withLibrary = () => install(["pg_keyspace.so"])
  const withoutLibrary = () => install(["supatype_mask.so"])

  it("serves it for a pinned project whose archive carries the library", async () => {
    await expect(nativeKeyspacePort(project(pinned), withLibrary(), "17.2.13", checks)).resolves.toBe(6379)
  })

  it("falls back to Valkey for a pinned project whose archive lacks the library", async () => {
    await expect(nativeKeyspacePort(project(pinned), withoutLibrary(), "17.2.13", checks)).resolves.toBeNull()
  })

  it("honours an explicit provider over what the archive carries", async () => {
    const valkey = project({ ...pinned, cache: { provider: "valkey" } })
    await expect(nativeKeyspacePort(valkey, withLibrary(), "17.2.13", checks)).resolves.toBeNull()
    const keyspace = project({ ...pinned, cache: { provider: "pg_keyspace" } })
    await expect(nativeKeyspacePort(keyspace, withLibrary(), "17.2.13", checks)).resolves.toBe(6379)
  })

  it("keeps Valkey for an external database even when the archive carries the library", async () => {
    const external = project({ ...pinned, database: { external: { url: "postgres://u:p@h:5432/d" } } })
    await expect(nativeKeyspacePort(external, withLibrary(), "17.2.13", checks)).resolves.toBeNull()
  })

  it("falls back to Valkey when no port is free", async () => {
    const noPort: NativeKeyspaceChecks = { ...checks, freePort: () => Promise.resolve(null) }
    await expect(nativeKeyspacePort(project(pinned), withLibrary(), "17.2.13", noPort)).resolves.toBeNull()
  })

  const LOGIN = { username: "supatype", password: "pw" }

  it("uses the keyspace only once its RESP listener answers", async () => {
    await expect(nativeKeyspaceAddr(6379, LOGIN, () => Promise.resolve(true))).resolves.toBe("127.0.0.1:6379")
    await expect(nativeKeyspaceAddr(6379, LOGIN, () => Promise.resolve(false))).resolves.toBeNull()
  })
})

/**
 * 0.9.2 release test (N-RB2): pg_keyspace listened on 0.0.0.0 with no password, so native dev on
 * Linux served an open, writable store to the network. From 17.2.13 the extension can listen on
 * loopback alone and read its password from a file, refusing every client that has not logged in
 * with it; native dev serves the keyspace
 * only from an archive that can, and keeps the Valkey sidecar for any older one.
 */
describe("the native keyspace is secured (N-RB2)", () => {
  const project = () => projectConfig({ project: { name: "acme" }, database: { provider: "native" } })
  const stubbed: NativeKeyspaceChecks = {
    libraryPresent: nativeKeyspaceLibraryPresent,
    freePort: () => Promise.resolve(6379),
  }

  it("listens on loopback only and reads its password from a file, never from a setting", () => {
    const o = pgServerOptions({
      pgBinDir: install(["pg_keyspace.so"]),
      dataDir: "/tmp/data",
      port: 55432,
      keyspacePort: 6379,
      keyspacePasswordFile: "/state/keyspace/password",
    })
    expect(o).toContain("-c pg_keyspace.password_file=/state/keyspace/password")
    expect(o).toContain("-c pg_keyspace.listen_address=127.0.0.1")
    // Implied by the password file, which refuses every client until the file is read.
    expect(o).not.toContain("require_auth")
  })

  it("quotes a setting with a space for the shell pg_ctl starts Postgres through", () => {
    expect(pgSettingArg("pg_keyspace.password_file", "/Users/Ada Lovelace/k", "linux")).toBe(
      "-c 'pg_keyspace.password_file=/Users/Ada Lovelace/k'",
    )
    expect(pgSettingArg("pg_keyspace.password_file", "/home/o'neil/k", "darwin")).toBe(
      "-c 'pg_keyspace.password_file=/home/o'\\''neil/k'",
    )
    expect(pgSettingArg("wal_level", "logical", "linux")).toBe("-c wal_level=logical")
  })

  it("serves the keyspace from an archive at 17.2.13 or later", async () => {
    for (const version of ["17.2.13", "17.3.0", "18.0.0"]) {
      await expect(nativeKeyspacePort(project(), install(["pg_keyspace.so"]), version, stubbed)).resolves.toBe(6379)
    }
  })

  it("keeps the Valkey sidecar for an archive that cannot require a password", async () => {
    for (const version of ["17.2.12", "17.2.9", "17.2", "17", null]) {
      await expect(nativeKeyspacePort(project(), install(["pg_keyspace.so"]), version, stubbed)).resolves.toBeNull()
    }
  })
})

/**
 * The extension reads the `supatype` user's password from `pg_keyspace.password_file` itself, at
 * start and on every reload. Native dev writes the project's password there before Postgres starts:
 * readable by this user alone, the password never in a command line, a setting or a log.
 */
describe("the native keyspace password file (N-RB2)", () => {
  const stateRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "supatype-ks-pw-"))
    roots.push(root)
    return root
  }

  it("holds the project's password and nothing else, under the project's state directory", () => {
    const root = stateRoot()
    const file = writeKeyspacePasswordFile(root, "s3cret with spaces")
    expect(file).toBe(join(root, "keyspace", "password"))
    expect(readFileSync(file, "utf8")).toBe("s3cret with spaces")
  })

  it("follows a password changed in .env at the next start", () => {
    const root = stateRoot()
    writeKeyspacePasswordFile(root, "first")
    expect(readFileSync(writeKeyspacePasswordFile(root, "second"), "utf8")).toBe("second")
  })

  it.skipIf(process.platform === "win32")("is readable by this user alone, even where an earlier one was not", () => {
    const root = stateRoot()
    mkdirSync(join(root, "keyspace"), { recursive: true, mode: 0o755 })
    writeFileSync(join(root, "keyspace", "password"), "old", { mode: 0o644 })
    const file = writeKeyspacePasswordFile(root, "new")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, "keyspace")).mode & 0o777).toBe(0o700)
  })
})
