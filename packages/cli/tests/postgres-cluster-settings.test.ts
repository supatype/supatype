import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { writeClusterSettings } from "../src/postgres-ctl.js"

/**
 * Local test round 4: the native data directory could not be started with plain `pg_ctl`
 * (`logical replication slot "supatype_realtime" exists, but "wal_level" < "logical"`), since dev
 * gave `wal_level` and the preloaded libraries on the command line only. The cluster keeps them in
 * `supatype.conf`, which its postgresql.conf includes; the keyspace's settings, chosen per run, stay
 * on the command line.
 */
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A data directory with a postgresql.conf, and an archive carrying `libs`. */
function cluster(libs: string[]): { dataDir: string; pgBinDir: string } {
  const root = mkdtempSync(join(tmpdir(), "supatype-cluster-settings-"))
  roots.push(root)
  const dataDir = join(root, "data")
  const pgBinDir = join(root, "pg", "bin")
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(pgBinDir, { recursive: true })
  mkdirSync(join(root, "pg", "lib"), { recursive: true })
  for (const lib of libs) writeFileSync(join(root, "pg", "lib", lib), "")
  writeFileSync(join(dataDir, "postgresql.conf"), "port = 5432\n")
  return { dataDir, pgBinDir }
}

describe("the native cluster's own settings", () => {
  it("keep wal_level and the preloaded libraries, but not the keyspace's", () => {
    const { dataDir, pgBinDir } = cluster(["pg_keyspace.so", "pg_cron.so", "supatype_mask.so"])
    writeClusterSettings({ dataDir, pgBinDir, keyspacePort: 6380, database: "acme" })

    const kept = readFileSync(join(dataDir, "supatype.conf"), "utf8")
    expect(kept).toContain("wal_level = 'logical'")
    expect(kept).toContain("shared_preload_libraries = 'pg_cron,supatype_mask'")
    expect(kept).toContain("cron.database_name = 'acme'")
    expect(kept).not.toContain("pg_keyspace")
    expect(readFileSync(join(dataDir, "postgresql.conf"), "utf8")).toContain("include_if_exists = 'supatype.conf'")
  })

  it("includes them once, however many starts", () => {
    const { dataDir, pgBinDir } = cluster([])
    for (let start = 0; start < 3; start++) writeClusterSettings({ dataDir, pgBinDir })
    const conf = readFileSync(join(dataDir, "postgresql.conf"), "utf8")
    expect(conf.split("include_if_exists = 'supatype.conf'")).toHaveLength(2)
  })
})
