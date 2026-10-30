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

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DEFAULT_DB_PORT, publishedDbPort } from "../src/db-port.js"
import { syncDatabaseUrlPort } from "../src/database-url-owner.js"
import { DATABASE_URL_MARKER } from "../src/env-file.js"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-dbport-"))
  // A port exported in the shell running the suite would otherwise decide every case below.
  for (const key of ["SUPATYPE_DB_PORT", "SUPATYPE_DEV_DB_PORT", "DATABASE_URL"]) vi.stubEnv(key, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * `lines` as `.env`, its DATABASE_URL labelled as the CLI's: only a URL the CLI owns follows the
 * port (a hand-written one is never changed, database-url-owner-rule.test.ts).
 */
function writeEnv(lines: string): void {
  writeFileSync(join(dir, ".env"), lines.replace(/^DATABASE_URL=/m, `${DATABASE_URL_MARKER}\nDATABASE_URL=`), "utf8")
}

function envText(): string {
  return readFileSync(join(dir, ".env"), "utf8")
}

describe("publishedDbPort", () => {
  it("defaults to the port compose binds for the layout when unset", () => {
    expect(publishedDbPort({}, false)).toBe(DEFAULT_DB_PORT)
    expect(publishedDbPort({}, true)).toBe(54329)
  })

  it("reads the self-host port for a self-host stack", () => {
    expect(publishedDbPort({ SUPATYPE_DB_PORT: "5433" }, false)).toBe(5433)
  })

  it("reads the dev port for a dev stack", () => {
    // Found by running the validation e2e: that project publishes on SUPATYPE_DEV_DB_PORT=54330
    // for its host-side engine, and an earlier version of this file rewrote a correct URL to 5432.
    expect(publishedDbPort({ SUPATYPE_DEV_DB_PORT: "54330", SUPATYPE_DB_PORT: "5433" }, true)).toBe(54330)
  })

  it("ignores the dev port for a self-host stack", () => {
    expect(publishedDbPort({ SUPATYPE_DEV_DB_PORT: "54330", SUPATYPE_DB_PORT: "5433" }, false)).toBe(5433)
  })

  it("falls back rather than inventing a port from nonsense", () => {
    // Compose reports a bad value far better than we can, and a made-up port would send the seed
    // somewhere nothing is listening with no clue why.
    for (const bad of ["", "   ", "abc", "-1", "0", "70000", "5433.5"]) {
      expect(publishedDbPort({ SUPATYPE_DB_PORT: bad }, false), `value ${JSON.stringify(bad)}`).toBe(
        DEFAULT_DB_PORT,
      )
    }
  })
})

describe("syncDatabaseUrlPort", () => {
  it("rewrites the port when the two disagree", () => {
    writeEnv("DATABASE_URL=postgresql://u:p@localhost:5432/acme\nSUPATYPE_DB_PORT=5433\n")
    expect(syncDatabaseUrlPort(dir, false)).toEqual({ from: "5432", to: "5433", envKey: "SUPATYPE_DB_PORT" })
    expect(envText()).toContain("localhost:5433/acme")
  })

  it("keeps the credentials, database and query string intact", () => {
    // The whole point is one field. A rewrite that dropped the password would take the stack down
    // in a way that looks nothing like a port problem.
    writeEnv(
      "DATABASE_URL=postgresql://supatype_admin:s3cr3t@127.0.0.1:5432/acme?sslmode=disable\nSUPATYPE_DB_PORT=5440\n",
    )
    syncDatabaseUrlPort(dir, false)
    const url = new URL(readFileSync(join(dir, ".env"), "utf8").match(/^DATABASE_URL=(.+)$/m)![1]!)
    expect(url.port).toBe("5440")
    expect(url.username).toBe("supatype_admin")
    expect(url.password).toBe("s3cr3t")
    expect(url.pathname).toBe("/acme")
    expect(url.searchParams.get("sslmode")).toBe("disable")
  })

  it("does nothing when they already agree", () => {
    writeEnv("DATABASE_URL=postgresql://u:p@localhost:5433/acme\nSUPATYPE_DB_PORT=5433\n")
    expect(syncDatabaseUrlPort(dir, false)).toBeNull()
  })

  it("treats an absent port as the default rather than rewriting it every run", () => {
    writeEnv("DATABASE_URL=postgresql://u:p@localhost/acme\n")
    expect(syncDatabaseUrlPort(dir, false)).toBeNull()
  })

  it("leaves a remote database alone", () => {
    // Somebody else's Postgres. Its port has nothing to do with our compose mapping, and
    // rewriting it would repoint the project at a database that does not exist.
    const remote = "postgresql://u:p@db.example.com:5432/acme"
    writeEnv(`DATABASE_URL=${remote}\nSUPATYPE_DB_PORT=5433\n`)
    expect(syncDatabaseUrlPort(dir, false)).toBeNull()
    expect(envText()).toContain(remote)
  })

  it("leaves a malformed URL alone rather than half-fixing it", () => {
    const broken = "postgres//u:p@localhost:5432/acme"
    writeEnv(`DATABASE_URL=${broken}\nSUPATYPE_DB_PORT=5433\n`)
    expect(syncDatabaseUrlPort(dir, false)).toBeNull()
    expect(envText()).toContain(broken)
  })

  it("does nothing when there is no DATABASE_URL at all", () => {
    writeEnv("SUPATYPE_DB_PORT=5433\n")
    expect(syncDatabaseUrlPort(dir, false)).toBeNull()
  })

  it("does nothing when there is no .env", () => {
    expect(syncDatabaseUrlPort(dir, false)).toBeNull()
  })
})

describe("syncDatabaseUrlPort follows the stack's own layout", () => {
  // Fresh-user test B5: a project that had run `supatype dev` carries SUPATYPE_DEV_DB_PORT in
  // `.env`. A self-host push then rewrote a correct DATABASE_URL to the dev port, so every
  // host-side command (seed, admin) reached the dev database, and the message named
  // SUPATYPE_DB_PORT, the variable it had not used.
  const both =
    "DATABASE_URL=postgresql://u:p@127.0.0.1:54390/acme\nSUPATYPE_DEV_DB_PORT=54329\nSUPATYPE_DB_PORT=54390\n"

  it("leaves a self-host URL on the self-host port though dev wrote its own", () => {
    writeEnv(both)
    expect(syncDatabaseUrlPort(dir, false)).toBeNull()
    expect(envText()).toContain("127.0.0.1:54390/acme")
  })

  it("moves a dev-port URL to the self-host port and names SUPATYPE_DB_PORT", () => {
    writeEnv(both.replace(":54390/", ":54329/"))
    expect(syncDatabaseUrlPort(dir, false)).toEqual({ from: "54329", to: "54390", envKey: "SUPATYPE_DB_PORT" })
  })

  it("names SUPATYPE_DEV_DB_PORT when a dev stack moves it", () => {
    writeEnv(both)
    expect(syncDatabaseUrlPort(dir, true)).toEqual({ from: "54390", to: "54329", envKey: "SUPATYPE_DEV_DB_PORT" })
  })

  it("uses the dev default port in dev when the variable is unset", () => {
    writeEnv("DATABASE_URL=postgresql://u:p@127.0.0.1:5432/acme\n")
    expect(syncDatabaseUrlPort(dir, true)).toEqual({ from: "5432", to: "54329", envKey: "SUPATYPE_DEV_DB_PORT" })
  })
})

describe("syncDatabaseUrlPort with a port given in the shell", () => {
  // Local test C: `SUPATYPE_DEV_DB_PORT=54339` exported, `.env` without it. Compose binds the
  // shell's port, and this read `.env` alone, so it kept DATABASE_URL on 54329, where nothing
  // listened. The shell's port is the run's (DR9): the URL follows it for this run, `.env` keeps
  // its own.
  it("points this run's DATABASE_URL at the shell's port and leaves .env alone", () => {
    vi.stubEnv("SUPATYPE_DEV_DB_PORT", "54339")
    writeEnv("DATABASE_URL=postgresql://u:p@127.0.0.1:54329/acme\n")
    expect(syncDatabaseUrlPort(dir, true)).toEqual({
      from: "54329",
      to: "54339",
      envKey: "SUPATYPE_DEV_DB_PORT",
      runOnly: true,
    })
    expect(process.env["DATABASE_URL"]).toBe("postgresql://u:p@127.0.0.1:54339/acme")
    expect(envText()).toContain("127.0.0.1:54329/acme")
  })

  it("leaves a DATABASE_URL the shell sets to the shell", () => {
    vi.stubEnv("SUPATYPE_DEV_DB_PORT", "54339")
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@127.0.0.1:6000/acme")
    writeEnv("DATABASE_URL=postgresql://u:p@127.0.0.1:54329/acme\n")
    expect(syncDatabaseUrlPort(dir, true)).toBeNull()
    expect(process.env["DATABASE_URL"]).toBe("postgresql://u:p@127.0.0.1:6000/acme")
    expect(envText()).toContain("127.0.0.1:54329/acme")
  })

  it("reads the shell's port for the stack's own layout only", () => {
    vi.stubEnv("SUPATYPE_DEV_DB_PORT", "54339")
    writeEnv("DATABASE_URL=postgresql://u:p@127.0.0.1:5432/acme\n")
    expect(syncDatabaseUrlPort(dir, false)).toBeNull()
    expect(process.env["DATABASE_URL"]).toBeUndefined()
  })

  // Local test C: a port the shell repeats from `.env` is the project's, not a throwaway, so
  // `DATABASE_URL` in `.env` follows it as it would with no export. Otherwise a developer who keeps
  // exporting the port they saved never sees `.env`'s URL move, and every other shell reaches 5432.
  it("moves .env's DATABASE_URL when .env names the same port as the shell", () => {
    vi.stubEnv("SUPATYPE_DEV_DB_PORT", "54339")
    writeEnv("SUPATYPE_DEV_DB_PORT=54339\nDATABASE_URL=postgresql://u:p@127.0.0.1:5432/acme\n")
    expect(syncDatabaseUrlPort(dir, true)).toEqual({ from: "5432", to: "54339", envKey: "SUPATYPE_DEV_DB_PORT" })
    expect(envText()).toContain("127.0.0.1:54339/acme")
  })
})
