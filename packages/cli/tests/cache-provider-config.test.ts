import { describe, it, expect } from "vitest"
import { validateProjectConfig } from "../src/project-config.js"
import { cacheProvider } from "../src/cache-provider.js"

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

describe("which provider a project actually runs", () => {
  /*
   * P9 flipped the default. The resolver is one function because the answer depends on two fields:
   * an absent `cache.provider` means pg_keyspace beside a database this stack starts and Valkey
   * beside an external one. A default written into the parser would have to be wrong for one of
   * them, or applied twice — and applied twice is how the compose file and the native path end up
   * disagreeing about which server is running, which is a cache that silently never hits and, with
   * TLS on, a Kong that cannot store its certificate.
   */
  const project = (over: Record<string, unknown>) =>
    ({
      project: { name: "acme" },
      database: { provider: "docker" },
      server: { mode: "dev" },
      app: { mode: "none" },
      ...over,
    }) as unknown as Parameters<typeof cacheProvider>[0]

  it("runs the keyspace in Postgres when nothing says otherwise", () => {
    expect(cacheProvider(project({}))).toBe("pg_keyspace")
    expect(cacheProvider(project({ cache: {} }))).toBe("pg_keyspace")
    expect(cacheProvider(project({ cache: { durablePrefixes: ["session:"] } }))).toBe("pg_keyspace")
  })

  it("keeps Valkey for a project that pins its Postgres image", () => {
    // The image honours SUPATYPE_KEYSPACE_ENABLED from the release that introduced it, and an
    // older one ignores it and starts with no RESP listener — no error anywhere, just a cache that
    // never hits. A pin says this project's image is fixed; a default cannot assume something
    // about a fixed image it has no way to check. Saying `pg_keyspace` explicitly still works, and
    // is the whole instruction for a project whose pin does carry the toggle.
    expect(cacheProvider(project({ versions: { postgres: "17.2" } }))).toBe("valkey")
    expect(
      cacheProvider(project({ versions: { postgres: "17.2" }, cache: { provider: "pg_keyspace" } })),
    ).toBe("pg_keyspace")
  })

  it("is unaffected by a pin on anything else", () => {
    // Only the Postgres image decides whether a keyspace can be served.
    expect(cacheProvider(project({ versions: { engine: "0.4.2", server: "0.1.0" } }))).toBe("pg_keyspace")
  })

  it("honours an explicit choice, including the one that is no longer the default", () => {
    // Selectable, not deprecated. A project that wrote `valkey` down keeps the sidecar.
    expect(cacheProvider(project({ cache: { provider: "valkey" } }))).toBe("valkey")
    expect(cacheProvider(project({ cache: { provider: "pg_keyspace" } }))).toBe("pg_keyspace")
  })

  it("resolves to Valkey for a database this stack does not start", () => {
    // Not a preference: pg_keyspace is loaded through shared_preload_libraries, so against an
    // unmanaged Postgres there is nothing to configure and Valkey is the only thing that can run.
    // Asking for pg_keyspace explicitly there is refused by validation rather than resolved here.
    expect(cacheProvider(project({ database: { external: { url: "postgres://u:p@h:5432/d" } } }))).toBe("valkey")
    expect(
      cacheProvider(project({ database: { external: { url: "postgres://u:p@h:5432/d" } }, cache: {} })),
    ).toBe("valkey")
  })
})
