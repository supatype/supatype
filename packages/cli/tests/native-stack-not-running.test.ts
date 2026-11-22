import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NoStackRunning } from "../src/host-database.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { requireLocalStack } from "../src/local-stack-guard.js"

/**
 * S-26: with native Postgres not running, a host command waited 42 to 96 s for its connection pool
 * to time out and said `pool timed out`, where a Docker project is refused at once with the one
 * sentence `cli.md` gives. A native project has a data directory, and a running server leaves a
 * `postmaster.pid` in it naming a live process, so the refusal needs no connection.
 */
let dataDir = ""
let config: SupatypeProjectConfig

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "supatype-native-data-"))
  config = {
    project: { name: "acme" },
    provider: "native",
    database: { provider: "native", data_dir: dataDir },
    server: { mode: "dev" },
    app: { mode: "none" },
  }
  vi.stubEnv("DATABASE_URL", undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dataDir, { recursive: true, force: true })
})

describe("a host command on a native project", () => {
  it("is refused at once when no Postgres is running for it", () => {
    expect(() => requireLocalStack(dataDir, config, "push", { direct: true })).toThrow(NoStackRunning)
  })

  it("is refused when the pid file names a process that is gone", () => {
    writeFileSync(join(dataDir, "postmaster.pid"), "2147483646\n" + dataDir + "\n0\n5432\n")
    expect(() => requireLocalStack(dataDir, config, "push", { direct: true })).toThrow(NoStackRunning)
  })

  it("goes ahead when the pid file names a live process", () => {
    writeFileSync(join(dataDir, "postmaster.pid"), `${process.pid}\n${dataDir}\n0\n5432\n`)
    expect(() => requireLocalStack(dataDir, config, "push", { direct: true })).not.toThrow()
  })

  it("is not refused when a database is named for the run", () => {
    expect(() => requireLocalStack(dataDir, config, "push", { connection: "postgresql://u:p@db.example.com:5432/x" })).not.toThrow()
  })
})
