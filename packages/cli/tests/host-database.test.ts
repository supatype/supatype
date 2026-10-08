/**
 * Which database a host-side command (seed, adopt, doctor, migrate, ...) connects to, and what it
 * says when it cannot tell.
 *
 * The error is the reason this is a file of its own. The old seed template carried a
 * hardcoded fallback DSN, so a project with no `.env` did not fail: it tried
 * `localhost:5432` with a guessed password and reported a connection error naming none of
 * the things it had looked at. Someone reading that cannot tell "I have not set
 * DATABASE_URL" from "the stack is not running", which is the difference between one
 * command and half an hour.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DsnNotFound, redact, resolveHostDatabaseUrl } from "../src/host-database.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

const SECRET = "postgres://user:s3cret@db.example.test:5432/app"

function config(overrides: Partial<SupatypeProjectConfig> = {}): SupatypeProjectConfig {
  return {
    project: { name: "launch-test" },
    database: { provider: "docker" },
    ...overrides,
  } as SupatypeProjectConfig
}

let cwd: string
let previousDatabaseUrl: string | undefined

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-dsn-"))
  mkdirSync(cwd, { recursive: true })
  previousDatabaseUrl = process.env["DATABASE_URL"]
  delete process.env["DATABASE_URL"]
})

afterEach(() => {
  if (previousDatabaseUrl === undefined) delete process.env["DATABASE_URL"]
  else process.env["DATABASE_URL"] = previousDatabaseUrl
  rmSync(cwd, { recursive: true, force: true })
})

describe("where the connection string comes from", () => {
  it("takes --connection first, because it was typed just now", () => {
    process.env["DATABASE_URL"] = "postgres://env/one"
    const resolved = resolveHostDatabaseUrl(cwd, config(), { connection: SECRET })
    expect(resolved.dsn).toBe(SECRET)
    expect(resolved.source).toBe("--connection")
  })

  /**
   * A stated external database is the whole stack's database. Seeding somewhere else while
   * the services read from here would look exactly like data loss, so it outranks the rest.
   */
  it("prefers a declared external database over DATABASE_URL", () => {
    process.env["DATABASE_URL"] = "postgres://env/one"
    const resolved = resolveHostDatabaseUrl(
      cwd,
      // `provider` is omitted when `external` is set: there is no backend to choose.
      config({ database: { external: { url: SECRET } } } as Partial<SupatypeProjectConfig>),
    )
    expect(resolved.dsn).toBe(SECRET)
  })

  it("takes `connection` from the config before the environment", () => {
    process.env["DATABASE_URL"] = "postgres://env/one"
    const resolved = resolveHostDatabaseUrl(cwd, config({ connection: SECRET } as Partial<SupatypeProjectConfig>))
    expect(resolved.dsn).toBe(SECRET)
  })

  it("takes DATABASE_URL from the environment", () => {
    process.env["DATABASE_URL"] = SECRET
    const resolved = resolveHostDatabaseUrl(cwd, config())
    expect(resolved.dsn).toBe(SECRET)
    expect(resolved.source).toBe("DATABASE_URL in the environment")
  })

  it("falls back to the project's .env", () => {
    writeFileSync(join(cwd, ".env"), `DATABASE_URL=${SECRET}\n`, "utf8")
    const resolved = resolveHostDatabaseUrl(cwd, config())
    expect(resolved.dsn).toBe(SECRET)
    expect(resolved.source).toContain(".env")
  })

  /** The usual rule, and the one Compose follows for the same names. */
  it("lets a real environment variable beat the file", () => {
    writeFileSync(join(cwd, ".env"), "DATABASE_URL=postgres://file/one\n", "utf8")
    process.env["DATABASE_URL"] = "postgres://env/two"
    expect(resolveHostDatabaseUrl(cwd, config()).dsn).toBe("postgres://env/two")
  })

  it("derives the published compose database for a docker project", () => {
    // Not the native layout: a docker stack has no `launch-test` database on 5432. It runs
    // `supatype` as `supatype_admin` on the port `supatype dev` publishes.
    const resolved = resolveHostDatabaseUrl(cwd, config(), { allowDerived: true })
    expect(resolved.dsn).toMatch(/^postgresql:\/\/supatype_admin:[^@]+@127\.0\.0\.1:54329\/supatype\?sslmode=disable$/)
    expect(resolved.source).toBe("the project's own local database")
  })

  // The user is the bundled image's own: it runs as supatype_admin whatever POSTGRES_USER says.
  it("reads the published port and credentials the stack was created with", () => {
    writeFileSync(
      join(cwd, ".env"),
      "SUPATYPE_DEV_DB_PORT=55555\nPOSTGRES_USER=owner\nPOSTGRES_PASSWORD=pw\nPOSTGRES_DB=app\n",
    )
    const resolved = resolveHostDatabaseUrl(cwd, config(), { allowDerived: true })
    expect(resolved.dsn).toBe("postgresql://supatype_admin:pw@127.0.0.1:55555/app?sslmode=disable")
  })

  it("derives the native layout for a native project", () => {
    const native = config({ database: { provider: "native" } } as Partial<SupatypeProjectConfig>)
    const resolved = resolveHostDatabaseUrl(cwd, native, { allowDerived: true })
    expect(resolved.dsn).toContain("launch-test")
  })
})

describe("when nothing names a database", () => {
  it("refuses rather than guessing", () => {
    expect(() => resolveHostDatabaseUrl(cwd, config())).toThrow(DsnNotFound)
  })

  it("names every source it tried, and what was at each", () => {
    let message = ""
    try {
      resolveHostDatabaseUrl(cwd, config())
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }

    for (const source of [
      "--connection",
      "database.external.url in supatype.config.ts",
      "connection in supatype.config.ts",
      "DATABASE_URL in the environment",
      ".env",
    ]) {
      expect(message).toContain(source)
    }
    expect(message).toContain("no .env file")
  })

  it("distinguishes a missing .env from one without the key", () => {
    writeFileSync(join(cwd, ".env"), "SOMETHING_ELSE=1\n", "utf8")
    let message = ""
    try {
      resolveHostDatabaseUrl(cwd, config())
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain("the file has no DATABASE_URL")
  })
})

describe("what reaches the terminal", () => {
  /**
   * Every one of these ends up in a terminal and often in a CI log. Printing a DSN to
   * explain where it came from should not be how a password ends up somewhere it is kept.
   */
  it("removes the password", () => {
    expect(redact(SECRET)).toBe("postgres://user:***@db.example.test:5432/app")
    expect(redact(SECRET)).not.toContain("s3cret")
  })

  it("leaves a connection string with no password alone", () => {
    expect(redact("postgres://db.example.test:5432/app")).toBe("postgres://db.example.test:5432/app")
  })

  it("does not print the password while explaining where it looked", () => {
    process.env["DATABASE_URL"] = SECRET
    const resolved = resolveHostDatabaseUrl(cwd, config())
    const printed = resolved.tried.map((source) => source.detail).join("\n")
    expect(printed).not.toContain("s3cret")
  })
})
