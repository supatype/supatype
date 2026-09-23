import { describe, it, expect } from "vitest"
import { validateProjectConfig } from "../src/project-config.js"

/**
 * `cache.provider` picks the RESP server the response cache and Kong's ACME
 * certificates share. Every rejection here is a case where accepting the
 * config would produce a stack that runs, and runs something other than what
 * was asked for.
 */
const validate = (cache: unknown, database: unknown = { provider: "docker" }) =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      database,
      server: { mode: "dev" },
      app: { mode: "none" },
      ...(cache === undefined ? {} : { cache }),
    },
    "supatype.config.ts",
  )

describe("cache.provider", () => {
  it("accepts both providers, and no cache section at all", () => {
    expect(() => validate(undefined)).not.toThrow()
    expect(() => validate({})).not.toThrow()
    expect(() => validate({ provider: "valkey" })).not.toThrow()
    expect(() => validate({ provider: "pg_keyspace" })).not.toThrow()
  })

  it("refuses a provider it does not have", () => {
    expect(() => validate({ provider: "redis" })).toThrow(/cache\.provider must be/)
  })

  // Rejected rather than silently downgraded to Valkey: a stack that quietly
  // runs the thing you switched away from is worse than one that will not start.
  it("refuses pg_keyspace against a database this stack does not start", () => {
    expect(() =>
      validate({ provider: "pg_keyspace" }, { external: { url: "postgres://u:p@h:5432/d" } }),
    ).toThrow(/needs the Postgres this stack starts/)
  })

  it("leaves valkey alone with an external database", () => {
    expect(() =>
      validate({ provider: "valkey" }, { external: { url: "postgres://u:p@h:5432/d" } }),
    ).not.toThrow()
  })
})

describe("cache.durablePrefixes", () => {
  it("accepts a list of prefixes", () => {
    expect(() => validate({ provider: "pg_keyspace", durablePrefixes: ["session:"] })).not.toThrow()
  })

  it("refuses anything that is not a list of non-empty strings", () => {
    for (const bad of ["session:", [""], [3], [null]]) {
      expect(() => validate({ provider: "pg_keyspace", durablePrefixes: bad })).toThrow(
        /must be an array of non-empty strings/,
      )
    }
  })

  // `,` separates entries and `=` separates a prefix from its tier in
  // pg_keyspace.durability_overrides. A prefix containing either would be read
  // as two settings, and the first sign of it would be a database that will
  // not start — long after the config was written.
  it("refuses a prefix carrying one of the separators", () => {
    for (const bad of ["a,b", "a=b"]) {
      expect(() => validate({ provider: "pg_keyspace", durablePrefixes: [bad] })).toThrow(
        /cannot contain "," or "="/,
      )
    }
  })
})
