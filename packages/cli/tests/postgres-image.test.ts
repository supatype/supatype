/**
 * VK2: what a `versions.postgres` pin runs, and the cache provider that follows from it.
 *
 * A pin used to pin nothing: every value mapped to `supatype/postgres:<major>-latest`, and the cache
 * provider fell back to Valkey for any pin on the assumption that the pin selected an image older
 * than the keyspace toggle. Neither was true of the image actually run. Now an exact `X.Y.Z` runs
 * that tag when it is published, `X` or `X.Y` runs `X-latest`, and the cache follows the image.
 *
 * The published-tag check is IO, so it is injected: nothing here needs Docker or a network.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cacheProvider } from "../src/cache-provider.js"
import {
  dockerTagCheck,
  resolvePostgresImage,
  setPostgresTagCheck,
  type PostgresTagCheck,
  type TagPresence,
} from "../src/postgres-image.js"
import { composeDockerImageEnv, renderSelfHostCompose } from "../src/self-host-compose.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

type ProjectOverrides = Partial<Pick<SupatypeProjectConfig, "versions" | "database" | "cache">>

function project(over: ProjectOverrides): SupatypeProjectConfig {
  return {
    project: { name: "acme" },
    database: { provider: "docker" },
    server: { mode: "dev" },
    app: { mode: "none" },
    ...over,
  }
}

const pinned = (postgres: string, over: ProjectOverrides = {}): SupatypeProjectConfig =>
  project({ versions: { postgres }, ...over })

/** Tags this fake registry has published; anything else is missing. */
const PUBLISHED = new Set(["17.2.8", "17.2.9", "17.2.10"])

const registry: PostgresTagCheck = (ref) => {
  const tag = ref.slice(ref.lastIndexOf(":") + 1)
  return PUBLISHED.has(tag) ? "published" : "missing"
}

const offline: PostgresTagCheck = () => "unknown"

afterEach(() => {
  setPostgresTagCheck(undefined)
  vi.restoreAllMocks()
})

describe("resolvePostgresImage", () => {
  const table: { pin: string; ref: string; keyspace: boolean }[] = [
    { pin: "17.2.10", ref: "supatype/postgres:17.2.10", keyspace: true },
    { pin: "17", ref: "supatype/postgres:17-latest", keyspace: true },
    { pin: "17.2", ref: "supatype/postgres:17-latest", keyspace: true },
    { pin: "v17.2.9", ref: "supatype/postgres:17.2.9", keyspace: true },
    { pin: "17.2.8", ref: "supatype/postgres:17.2.8", keyspace: false },
    { pin: "17-latest", ref: "supatype/postgres:17-latest", keyspace: true },
  ]

  for (const row of table) {
    it(`runs ${row.ref} for a "${row.pin}" pin, keyspace ${row.keyspace}`, () => {
      const image = resolvePostgresImage(pinned(row.pin), registry)
      expect(image.ref).toBe(row.ref)
      expect(image.keyspace).toBe(row.keyspace)
      expect(image.warning).toBeUndefined()
    })
  }

  it("never asks the registry about a major or major.minor pin, and never runs the stale 17.2 tag", () => {
    const asked: string[] = []
    const spy: PostgresTagCheck = (ref) => {
      asked.push(ref)
      return "published"
    }
    expect(resolvePostgresImage(pinned("17.2"), spy).ref).toBe("supatype/postgres:17-latest")
    expect(resolvePostgresImage(pinned("17"), spy).ref).toBe("supatype/postgres:17-latest")
    expect(asked).toEqual([])
  })

  it("falls back to the major and says so when an exact pin is not published", () => {
    const image = resolvePostgresImage(pinned("17.2.99"), registry)
    expect(image.ref).toBe("supatype/postgres:17-latest")
    expect(image.keyspace).toBe(true)
    expect(image.warning).toContain('versions.postgres "17.2.99"')
    expect(image.warning).toContain("supatype/postgres:17.2.99 is not published")
    expect(image.warning).toContain("running supatype/postgres:17-latest instead")
  })

  it("runs an exact tag found locally even when the registry cannot be asked", () => {
    const localOnly: PostgresTagCheck = (ref) => (ref === "supatype/postgres:17.2.10" ? "local" : "unknown")
    const image = resolvePostgresImage(pinned("17.2.10"), localOnly)
    expect(image.ref).toBe("supatype/postgres:17.2.10")
    expect(image.warning).toBeUndefined()
  })

  it("falls back to the major with a warning when the check cannot be done at all", () => {
    const image = resolvePostgresImage(pinned("17.2.10"), offline)
    expect(image.ref).toBe("supatype/postgres:17-latest")
    expect(image.keyspace).toBe(true)
    expect(image.warning).toContain('versions.postgres "17.2.10"')
    expect(image.warning).toContain("could not check whether supatype/postgres:17.2.10 is published")
    expect(image.warning).toContain("running supatype/postgres:17-latest instead")
  })

  it("runs database.image as given and cannot vouch for its keyspace", () => {
    const image = resolvePostgresImage(
      pinned("17.2.10", { database: { provider: "docker", image: "registry.example.com/pg:17" } }),
      registry,
    )
    expect(image.ref).toBe("registry.example.com/pg:17")
    expect(image.keyspace).toBe(false)
  })

  it("leaves an unpinned project on the compose default, the Postgres release this CLI pins", () => {
    const image = resolvePostgresImage(project({}), registry)
    expect(image.ref).toBeUndefined()
    expect(image.keyspace).toBe(true)
  })
})

describe("cacheProvider follows the image actually run", () => {
  const cases: { name: string; config: SupatypeProjectConfig; provider: "valkey" | "pg_keyspace" }[] = [
    { name: "a published exact pin from 17.2.9", config: pinned("17.2.10"), provider: "pg_keyspace" },
    { name: "an unpublished exact pin, which runs 17-latest", config: pinned("17.2.99"), provider: "pg_keyspace" },
    { name: "a major pin", config: pinned("17"), provider: "pg_keyspace" },
    { name: "a major.minor pin", config: pinned("17.2"), provider: "pg_keyspace" },
    { name: "a v-prefixed exact pin at the threshold", config: pinned("v17.2.9"), provider: "pg_keyspace" },
    { name: "an exact pin before the toggle", config: pinned("17.2.8"), provider: "valkey" },
    { name: "a -latest pin", config: pinned("17-latest"), provider: "pg_keyspace" },
    {
      name: "a custom database.image",
      config: project({ database: { provider: "docker", image: "registry.example.com/pg:17" } }),
      provider: "valkey",
    },
    {
      name: "an explicit pg_keyspace on an old pin",
      config: pinned("17.2.8", { cache: { provider: "pg_keyspace" } }),
      provider: "pg_keyspace",
    },
    { name: "an explicit valkey on a capable pin", config: pinned("17.2.10", { cache: { provider: "valkey" } }), provider: "valkey" },
    {
      name: "an external database",
      config: pinned("17.2.10", { database: { external: { url: "postgres://u:p@h:5432/d" } } }),
      provider: "valkey",
    },
  ]

  for (const c of cases) {
    it(`is ${c.provider} for ${c.name}`, () => {
      setPostgresTagCheck(registry)
      expect(cacheProvider(c.config)).toBe(c.provider)
    })
  }

  it("is pg_keyspace offline, because the fallback it runs is X-latest", () => {
    setPostgresTagCheck(offline)
    expect(cacheProvider(pinned("17.2.10"))).toBe("pg_keyspace")
  })

  it("decides once per process and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    let calls = 0
    setPostgresTagCheck((ref) => {
      calls += 1
      return registry(ref)
    })
    const config = pinned("17.2.99")
    cacheProvider(config)
    composeDockerImageEnv(config)
    renderSelfHostCompose(config)
    expect(calls).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe("the compose file runs the resolved image with the matching keyspace", () => {
  it("runs a published exact pin with the keyspace on", () => {
    setPostgresTagCheck(registry)
    const config = pinned("17.2.10")
    expect(composeDockerImageEnv(config)["SUPATYPE_POSTGRES_IMAGE"]).toBe("supatype/postgres:17.2.10")
    const compose = renderSelfHostCompose(config)
    expect(compose).toContain("image: ${SUPATYPE_POSTGRES_IMAGE:-supatype/postgres:17.2.10}")
    expect(compose).toContain('SUPATYPE_KEYSPACE_ENABLED: "1"')
    expect(compose).not.toContain("\n  valkey:\n")
  })

  it("runs an exact pin before the toggle beside a Valkey sidecar", () => {
    setPostgresTagCheck(registry)
    const compose = renderSelfHostCompose(pinned("17.2.8"))
    expect(compose).toContain("image: ${SUPATYPE_POSTGRES_IMAGE:-supatype/postgres:17.2.8}")
    expect(compose).not.toContain("SUPATYPE_KEYSPACE_ENABLED")
    expect(compose).toContain("\n  valkey:\n")
  })

  it("runs 17-latest with the keyspace for an unpublished exact pin", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    setPostgresTagCheck(registry)
    const config = pinned("17.2.99")
    expect(composeDockerImageEnv(config)["SUPATYPE_POSTGRES_IMAGE"]).toBe("supatype/postgres:17-latest")
    const compose = renderSelfHostCompose(config)
    expect(compose).toContain("image: ${SUPATYPE_POSTGRES_IMAGE:-supatype/postgres:17-latest}")
    expect(compose).toContain('SUPATYPE_KEYSPACE_ENABLED: "1"')
  })
})

describe("dockerTagCheck asks the local image store first, then the registry", () => {
  type Result = { status: number | null; stderr: string }
  const runner = (answers: Record<string, Result>) => {
    const asked: string[] = []
    const run = (args: string[]): Result => {
      const key = args.slice(0, 2).join(" ")
      asked.push(key)
      return answers[key] ?? { status: null, stderr: "" }
    }
    return { run, asked }
  }
  const REF = "supatype/postgres:17.2.10"

  const rows: { name: string; answers: Record<string, Result>; presence: TagPresence; asked: string[] }[] = [
    {
      name: "present locally, without asking the registry",
      answers: { "image inspect": { status: 0, stderr: "" } },
      presence: "local",
      asked: ["image inspect"],
    },
    {
      name: "published",
      answers: { "image inspect": { status: 1, stderr: "No such image" }, "manifest inspect": { status: 0, stderr: "" } },
      presence: "published",
      asked: ["image inspect", "manifest inspect"],
    },
    {
      name: "missing from the registry",
      answers: {
        "image inspect": { status: 1, stderr: "No such image" },
        "manifest inspect": { status: 1, stderr: `no such manifest: docker.io/${REF}` },
      },
      presence: "missing",
      asked: ["image inspect", "manifest inspect"],
    },
    {
      name: "unknown when the registry cannot be reached",
      answers: {
        "image inspect": { status: 1, stderr: "No such image" },
        "manifest inspect": { status: 1, stderr: "dial tcp: lookup registry-1.docker.io: no such host" },
      },
      presence: "unknown",
      asked: ["image inspect", "manifest inspect"],
    },
    { name: "unknown without Docker", answers: {}, presence: "unknown", asked: ["image inspect", "manifest inspect"] },
  ]

  for (const row of rows) {
    it(`reports ${row.presence}: ${row.name}`, () => {
      const { run, asked } = runner(row.answers)
      expect(dockerTagCheck(run)(REF)).toBe(row.presence)
      expect(asked).toEqual(row.asked)
    })
  }
})
