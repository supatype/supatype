/**
 * `DATABASE_URL` has to name the port Postgres is published on.
 *
 * `SUPATYPE_DB_PORT` moves the host side of the compose mapping so two projects can coexist on one
 * machine. `DATABASE_URL` is what every host-side script uses. Nothing reconciled them, so a
 * project moved to 5433 started cleanly, served every request, and failed on its own seed script
 * with `ECONNREFUSED 127.0.0.1:5432`, naming a port the person never chose.
 *
 * The cases that matter most here are the ones where it must NOT act: a remote database is not
 * ours to repoint, and a malformed URL is not ours to half-fix.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DEFAULT_DB_PORT, publishedDbPort, syncDatabaseUrlPort } from "../src/db-port.js"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-dbport-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeEnv(lines: string): void {
  writeFileSync(join(dir, ".env"), lines, "utf8")
}

function envText(): string {
  return readFileSync(join(dir, ".env"), "utf8")
}

describe("publishedDbPort", () => {
  it("defaults to the port compose binds when unset", () => {
    expect(publishedDbPort({})).toBe(DEFAULT_DB_PORT)
  })

  it("reads the configured port", () => {
    expect(publishedDbPort({ SUPATYPE_DB_PORT: "5433" })).toBe(5433)
  })

  it("prefers the dev-local port, because its presence marks the deployment shape", () => {
    // Found by running the validation e2e: that project publishes on SUPATYPE_DEV_DB_PORT=54330
    // for its host-side engine, and an earlier version of this file rewrote a correct URL to 5432.
    expect(publishedDbPort({ SUPATYPE_DEV_DB_PORT: "54330" })).toBe(54330)
    expect(publishedDbPort({ SUPATYPE_DEV_DB_PORT: "54330", SUPATYPE_DB_PORT: "5433" })).toBe(54330)
  })

  it("uses the self-host port when there is no dev-local one", () => {
    expect(publishedDbPort({ SUPATYPE_DB_PORT: "5433" })).toBe(5433)
  })

  it("falls through a nonsense dev-local port to the self-host one", () => {
    expect(publishedDbPort({ SUPATYPE_DEV_DB_PORT: "abc", SUPATYPE_DB_PORT: "5433" })).toBe(5433)
  })

  it("falls back rather than inventing a port from nonsense", () => {
    // Compose reports a bad value far better than we can, and a made-up port would send the seed
    // somewhere nothing is listening with no clue why.
    for (const bad of ["", "   ", "abc", "-1", "0", "70000", "5433.5"]) {
      expect(publishedDbPort({ SUPATYPE_DB_PORT: bad }), `value ${JSON.stringify(bad)}`).toBe(
        DEFAULT_DB_PORT,
      )
    }
  })
})

describe("syncDatabaseUrlPort", () => {
  it("rewrites the port when the two disagree", () => {
    writeEnv("DATABASE_URL=postgresql://u:p@localhost:5432/acme\nSUPATYPE_DB_PORT=5433\n")
    expect(syncDatabaseUrlPort(dir)).toEqual({ from: "5432", to: "5433" })
    expect(envText()).toContain("localhost:5433/acme")
  })

  it("keeps the credentials, database and query string intact", () => {
    // The whole point is one field. A rewrite that dropped the password would take the stack down
    // in a way that looks nothing like a port problem.
    writeEnv(
      "DATABASE_URL=postgresql://supatype_admin:s3cr3t@127.0.0.1:5432/acme?sslmode=disable\nSUPATYPE_DB_PORT=5440\n",
    )
    syncDatabaseUrlPort(dir)
    const url = new URL(readFileSync(join(dir, ".env"), "utf8").match(/^DATABASE_URL=(.+)$/m)![1]!)
    expect(url.port).toBe("5440")
    expect(url.username).toBe("supatype_admin")
    expect(url.password).toBe("s3cr3t")
    expect(url.pathname).toBe("/acme")
    expect(url.searchParams.get("sslmode")).toBe("disable")
  })

  it("does nothing when they already agree", () => {
    writeEnv("DATABASE_URL=postgresql://u:p@localhost:5433/acme\nSUPATYPE_DB_PORT=5433\n")
    expect(syncDatabaseUrlPort(dir)).toBeNull()
  })

  it("treats an absent port as the default rather than rewriting it every run", () => {
    writeEnv("DATABASE_URL=postgresql://u:p@localhost/acme\n")
    expect(syncDatabaseUrlPort(dir)).toBeNull()
  })

  it("leaves a remote database alone", () => {
    // Somebody else's Postgres. Its port has nothing to do with our compose mapping, and
    // rewriting it would repoint the project at a database that does not exist.
    const remote = "postgresql://u:p@db.example.com:5432/acme"
    writeEnv(`DATABASE_URL=${remote}\nSUPATYPE_DB_PORT=5433\n`)
    expect(syncDatabaseUrlPort(dir)).toBeNull()
    expect(envText()).toContain(remote)
  })

  it("leaves a malformed URL alone rather than half-fixing it", () => {
    const broken = "postgres//u:p@localhost:5432/acme"
    writeEnv(`DATABASE_URL=${broken}\nSUPATYPE_DB_PORT=5433\n`)
    expect(syncDatabaseUrlPort(dir)).toBeNull()
    expect(envText()).toContain(broken)
  })

  it("does nothing when there is no DATABASE_URL at all", () => {
    writeEnv("SUPATYPE_DB_PORT=5433\n")
    expect(syncDatabaseUrlPort(dir)).toBeNull()
  })

  it("does nothing when there is no .env", () => {
    expect(syncDatabaseUrlPort(dir)).toBeNull()
  })
})
