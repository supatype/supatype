/**
 * Native `supatype dev` binds its Postgres and realtime ports where the project says.
 *
 * They were fixed at 5432 and 4000 with no way to move them, so native dev could not start beside
 * anything holding either: another project's Postgres, a system Postgres, a local app on 4000.
 * The Docker provider has always taken its ports from the environment or `.env`; native takes the
 * same Postgres key (`SUPATYPE_DEV_DB_PORT`, the port this project's dev Postgres is on), a
 * realtime key in the same style, and a config fallback for each.
 *
 * Every command that reaches the native database derives its address from `localDSN`, so the
 * port has to be there too, not only where dev starts the server.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  localDSN,
  nativeDbPort,
  nativeRealtimePort,
  type SupatypeProjectConfig,
} from "../src/project-config.js"
import { projectConfig } from "./support/project-config.js"

let dir: string
const saved: Record<string, string | undefined> = {}
const KEYS = ["SUPATYPE_DEV_DB_PORT", "SUPATYPE_REALTIME_PORT"]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-native-ports-"))
  for (const key of KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

function config(extra: { dbPort?: number; realtimePort?: number } = {}): SupatypeProjectConfig {
  return projectConfig({
    database: { ...(extra.dbPort !== undefined && { port: extra.dbPort }) },
    server: { mode: "dev", ...(extra.realtimePort !== undefined && { realtimePort: extra.realtimePort }) },
  })
}

describe("the native Postgres port", () => {
  it("is 5432 when nothing moves it", () => {
    expect(nativeDbPort(config(), dir)).toBe(5432)
  })

  it("comes from .env's SUPATYPE_DEV_DB_PORT, the key Docker dev uses for the same Postgres", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_DEV_DB_PORT=55651\n")
    expect(nativeDbPort(config(), dir)).toBe(55651)
  })

  it("prefers an exported SUPATYPE_DEV_DB_PORT over .env, as compose does", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_DEV_DB_PORT=55651\n")
    process.env["SUPATYPE_DEV_DB_PORT"] = "55652"
    expect(nativeDbPort(config(), dir)).toBe(55652)
  })

  it("falls back to database.port in the config", () => {
    expect(nativeDbPort(config({ dbPort: 55653 }), dir)).toBe(55653)
  })

  it("is the port in the local connection string every other command uses", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_DEV_DB_PORT=55651\n")
    expect(localDSN(config(), "pw", dir)).toBe("postgres://postgres:pw@127.0.0.1:55651/demo?sslmode=disable")
  })
})

describe("the native realtime port", () => {
  it("is 4000 when nothing moves it", () => {
    expect(nativeRealtimePort(config(), dir)).toBe(4000)
  })

  it("comes from SUPATYPE_REALTIME_PORT, exported or in .env", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_REALTIME_PORT=55654\n")
    expect(nativeRealtimePort(config(), dir)).toBe(55654)
    process.env["SUPATYPE_REALTIME_PORT"] = "55655"
    expect(nativeRealtimePort(config(), dir)).toBe(55655)
  })

  it("falls back to server.realtimePort in the config", () => {
    expect(nativeRealtimePort(config({ realtimePort: 55656 }), dir)).toBe(55656)
  })
})
