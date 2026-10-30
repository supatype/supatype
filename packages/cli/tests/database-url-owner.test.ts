import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"
import { ensureDevDbPort } from "../src/dev-ports.js"
import { MANAGED_MARKER } from "../src/env-file.js"
import { resolveHostDatabaseUrl } from "../src/host-database.js"
import { databaseUrlOwner, reconcileNativeDatabaseUrl, writeCliDatabaseUrl } from "../src/database-url-owner.js"
import { localDSN, validateProjectConfig } from "../src/project-config.js"

/**
 * Local test N1: a project made with `init` for Docker and then run native failed `supatype push`
 * with ECONNREFUSED. `init` had written a Docker DATABASE_URL into `.env`, every host command reads
 * `.env`'s URL ahead of the project's own database, and nothing could tell a URL the CLI wrote from
 * one a person did. The CLI now marks what it writes. A URL it wrote, marked, or unmarked but
 * exactly the shape `init` writes, belongs to whichever provider the project runs; a hand-written
 * one always wins.
 */
const PASSWORD = "pw/x"
const INIT_URL = `postgresql://supatype_admin:${encodeURIComponent(PASSWORD)}@localhost:5432/acme`
let dir = ""

const native = validateProjectConfig(
  { project: { name: "acme" }, provider: "native", server: { mode: "dev" }, app: { mode: "none" }, database: { provider: "native" } },
  "supatype.config.ts",
)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-db-url-owner-"))
  for (const key of ["DATABASE_URL", "SUPATYPE_DEV_DB_PORT", "SUPATYPE_DB_PORT"]) vi.stubEnv(key, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function writeEnv(lines: string[]): void {
  writeFileSync(join(dir, ".env"), `${lines.join("\n")}\nPOSTGRES_PASSWORD=${PASSWORD}\nPOSTGRES_DB=acme\n`, "utf8")
}

const nativeDsn = (): string => localDSN(native, PASSWORD, dir)

describe("who wrote DATABASE_URL", () => {
  it("init marks the URL it writes", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    scaffold(dir, defaultScaffoldOptions("acme"))
    expect(databaseUrlOwner(dir)).toBe("cli")
  })

  it("dev marks the URL it writes for the port it chose", async () => {
    writeEnv([])
    await ensureDevDbPort(dir)
    expect(databaseUrlOwner(dir)).toBe("cli")
  })

  it("rewriting a URL keeps it the CLI's, and leaves one that is yours alone", () => {
    writeEnv(["DATABASE_URL=postgresql://me:secret@localhost:5432/mine"])
    expect(writeCliDatabaseUrl(dir, INIT_URL)).toBe("yours")
    expect(databaseUrlOwner(dir)).toBe("you")
    writeEnv([MANAGED_MARKER, "DATABASE_URL=postgresql://supatype_admin:other@localhost:5432/acme"])
    writeCliDatabaseUrl(dir, INIT_URL.replace("5432", "5433"))
    expect(databaseUrlOwner(dir)).toBe("cli")
  })
})

describe("a native project's host commands", () => {
  it("reach the native database past a URL init wrote for Docker", () => {
    writeEnv([`DATABASE_URL=${INIT_URL}`])
    expect(resolveHostDatabaseUrl(dir, native, { allowDerived: true }).dsn).toBe(nativeDsn())
  })

  it("reach the native database past any URL the CLI marked", () => {
    writeEnv([MANAGED_MARKER, "DATABASE_URL=postgresql://supatype_admin:other@127.0.0.1:54339/acme?sslmode=disable"])
    expect(resolveHostDatabaseUrl(dir, native, { allowDerived: true }).dsn).toBe(nativeDsn())
  })

  it("use a hand-written URL as written", () => {
    writeEnv(["DATABASE_URL=postgresql://me:secret@localhost:6000/mine"])
    expect(resolveHostDatabaseUrl(dir, native, { allowDerived: true }).dsn).toBe("postgresql://me:secret@localhost:6000/mine")
  })
})

describe("native dev and .env's DATABASE_URL", () => {
  it("points a URL the CLI wrote at the native database, labelled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    writeEnv([`DATABASE_URL=${INIT_URL}`])
    await reconcileNativeDatabaseUrl(dir, nativeDsn())
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(`DATABASE_URL=${nativeDsn()}`)
    expect(databaseUrlOwner(dir)).toBe("cli")
  })

  it("says when native dev moves the URL, and warns about a hand-written one nothing answers on", async () => {
    const said: string[] = []
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
    writeEnv([`DATABASE_URL=${INIT_URL}`])
    await reconcileNativeDatabaseUrl(dir, nativeDsn())
    expect(said.join("\n")).toMatch(/DATABASE_URL in \.env now names/)
    said.length = 0
    writeEnv(["DATABASE_URL=postgresql://me:secret@127.0.0.1:1/mine"])
    await reconcileNativeDatabaseUrl(dir, nativeDsn())
    expect(said.join("\n")).toMatch(/names 127\.0\.0\.1:1, and nothing answers there/)
    expect(said.join("\n")).not.toContain("secret")
  })

  it("leaves a hand-written URL alone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    writeEnv(["DATABASE_URL=postgresql://me:secret@localhost:6000/mine"])
    await reconcileNativeDatabaseUrl(dir, nativeDsn())
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("DATABASE_URL=postgresql://me:secret@localhost:6000/mine")
  })
})

// Pre-push review: a password with a `%` that is not an escape made decodeURIComponent throw, and
// reading whose `.env` URL it was threw with it. A URL the CLI cannot read is not one it wrote.
describe("a DATABASE_URL whose password does not decode", () => {
  it("is yours, and reading it does not throw", () => {
    writeEnv(["DATABASE_URL=postgresql://supatype_admin:100%zz@localhost:5432/acme"])
    expect(databaseUrlOwner(dir)).toBe("you")
  })
})

// Pre-push review: the warning told a developer to remove a URL to another machine because this
// one could not reach it, which says nothing about the database (a VPN down, a firewall). Only a
// URL to this machine is checked; one elsewhere is theirs to reach.
describe("a hand-written DATABASE_URL to another machine", () => {
  it("is not warned about, nor told to be removed", async () => {
    const said: string[] = []
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
    writeEnv(["DATABASE_URL=postgresql://me:secret@db.invalid:5432/mine"])
    await reconcileNativeDatabaseUrl(dir, nativeDsn())
    expect(said).toEqual([])
  })
})
