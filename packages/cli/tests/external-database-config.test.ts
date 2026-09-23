import { describe, it, expect } from "vitest"
import {
  connectionString,
  externalDatabaseUrl,
  realtimeEnabled,
  usesExternalDatabase,
  validateProjectConfig,
  type SupatypeProjectConfig,
} from "../src/project-config.js"

/**
 * `database.external` points the stack at a Postgres Supatype did not create.
 *
 * Every rejection here is a case where two settings describe the same fact. Picking a silent winner
 * is how a push lands somewhere other than where the services read, which presents as data loss and
 * is not.
 */
const EXTERNAL_URL = "postgres://owner:secret@db.example.com:5432/app"

const raw = (database: unknown, rest: Record<string, unknown> = {}): unknown => ({
  project: { name: "acme" },
  database,
  server: { mode: "dev" },
  app: { mode: "none" },
  ...rest,
})

const validate = (database: unknown, rest?: Record<string, unknown>) =>
  validateProjectConfig(raw(database, rest), "supatype.config.ts")

describe("database.external: accepted", () => {
  it("accepts a url on its own, with no database.provider", () => {
    const cfg = validate({ external: { url: EXTERNAL_URL } })
    expect(externalDatabaseUrl(cfg)).toBe(EXTERNAL_URL)
    expect(usesExternalDatabase(cfg)).toBe(true)
  })

  it("leaves a managed project alone", () => {
    const cfg = validate({ provider: "docker" })
    expect(usesExternalDatabase(cfg)).toBe(false)
    expect(externalDatabaseUrl(cfg)).toBeUndefined()
  })

  it("accepts postgresql:// as well as postgres://", () => {
    expect(() => validate({ external: { url: "postgresql://u:p@h:5432/d" } })).not.toThrow()
  })

  it("accepts an identical `connection`, since nothing is ambiguous", () => {
    expect(() =>
      validate({ external: { url: EXTERNAL_URL } }, { connection: EXTERNAL_URL }),
    ).not.toThrow()
  })
})

describe("database.external: rejected", () => {
  it("rejects a missing url", () => {
    expect(() => validate({ external: {} })).toThrow(/database\.external\.url is required/)
    expect(() => validate({ external: { url: "   " } })).toThrow(
      /database\.external\.url is required/,
    )
  })

  it("rejects a url that is not Postgres, naming what it got", () => {
    // A `mysql://` or a bare host is a typo, and the failure it would otherwise cause is six
    // services failing to connect with no mention of the setting responsible.
    expect(() => validate({ external: { url: "mysql://u:p@h/d" } })).toThrow(
      /must be a postgres:\/\/ or postgresql:\/\/ URL \(got "mysql:\/\/u:p@h\/d"\)/,
    )
    expect(() => validate({ external: { url: "db.example.com:5432" } })).toThrow(
      /must be a postgres/,
    )
  })

  it("rejects external beside database.provider instead of picking one", () => {
    expect(() => validate({ provider: "docker", external: { url: EXTERNAL_URL } })).toThrow(
      /cannot both be set/,
    )
    // And says which to remove, since the top-level `provider` still chooses the runtime stack.
    expect(() => validate({ provider: "native", external: { url: EXTERNAL_URL } })).toThrow(
      /Remove database\.provider/,
    )
  })

  it("rejects external on the cloud path", () => {
    expect(() =>
      validateProjectConfig(
        {
          project: { name: "acme" },
          database: { external: { url: EXTERNAL_URL } },
          server: { mode: "managed" },
          app: { mode: "none" },
        },
        "supatype.config.ts",
      ),
    ).toThrow(/not supported with server\.mode "managed"/)
  })

  it("rejects a `connection` that disagrees with the external url", () => {
    expect(() =>
      validate(
        { external: { url: EXTERNAL_URL } },
        { connection: "postgres://elsewhere:5432/other" },
      ),
    ).toThrow(/both set and disagree/)
  })

  it("rejects a non-boolean realtime flag", () => {
    expect(() => validate({ external: { url: EXTERNAL_URL, realtime: "no" } })).toThrow(
      /realtime must be true or false/,
    )
  })

  it("rejects a non-object external block", () => {
    expect(() => validate({ external: EXTERNAL_URL })).toThrow(/must be an object with a url/)
    expect(() => validate({ external: [EXTERNAL_URL] })).toThrow(/must be an object with a url/)
  })
})

describe("resolution", () => {
  const external = (realtime?: boolean): SupatypeProjectConfig =>
    validate({
      external: { url: EXTERNAL_URL, ...(realtime !== undefined && { realtime }) },
    })

  it("uses the external url for CLI commands too", () => {
    // Ahead of DATABASE_URL deliberately: a push that went to the env var's database while the
    // services read from the external one is indistinguishable from losing the data.
    const previous = process.env["DATABASE_URL"]
    process.env["DATABASE_URL"] = "postgres://env:5432/env"
    try {
      expect(connectionString(external())).toBe(EXTERNAL_URL)
    } finally {
      if (previous === undefined) delete process.env["DATABASE_URL"]
      else process.env["DATABASE_URL"] = previous
    }
  })

  it("leaves DATABASE_URL in charge for a managed project", () => {
    const previous = process.env["DATABASE_URL"]
    process.env["DATABASE_URL"] = "postgres://env:5432/env"
    try {
      expect(connectionString(validate({ provider: "docker" }))).toBe("postgres://env:5432/env")
    } finally {
      if (previous === undefined) delete process.env["DATABASE_URL"]
      else process.env["DATABASE_URL"] = previous
    }
  })

  it("runs realtime unless told not to", () => {
    expect(realtimeEnabled(external())).toBe(true)
    expect(realtimeEnabled(external(false))).toBe(false)
    expect(realtimeEnabled(validate({ provider: "docker" }))).toBe(true)
  })
})
