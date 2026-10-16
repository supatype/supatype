import { describe, it, expect } from "vitest"
import { mergeProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"

/**
 * `supatype.local.config.ts` is merged over `supatype.config.ts`, and every top-level key has to
 * survive that.
 *
 * The merge used to copy a fixed list of keys, so `cache`, `api` and `publishing` set in either file
 * were dropped without a word: the stack ran on defaults while the config said otherwise.
 *
 * `LOCAL` sets every key. Typed `Required<...>`, it stops compiling the day the config gains a key
 * it does not set, so a new key cannot be added without this test covering it.
 */
const LOCAL: Required<SupatypeProjectConfig> = {
  provider: "docker",
  supatype: { root: "./supatype" },
  project: { name: "local", ref: "ref-local" },
  database: { provider: "docker", port: 5544 },
  server: { mode: "dev", port: 18480 },
  api: { corsOrigins: ["https://local.example"] },
  cache: { provider: "valkey", durablePrefixes: ["local:"] },
  app: { mode: "static", static_dir: "./dist" },
  versions: { engine: "9.9.9" },
  overrides: { engine: "/opt/engine" },
  email: { provider: "smtp", smtp: { host: "smtp.local" } },
  auth: { providers: { keycloak: { clientId: "local-client" } } },
  storage: { provider: "local", local_path: "./storage" },
  schema: { pg_schema: "app" },
  publishing: { draft_visibility: ["admin"], preview: { default_ttl: 60 } },
  functions: { path: "./functions" },
  output: { types: "./types.ts" },
  build: { framework: "vite" },
  environments: { default: "dev", branchDefaults: { main: "production" } },
  connection: "postgres://local",
  admin: { roles: ["admin"] },
}

const BASE: SupatypeProjectConfig = {
  project: { name: "base" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
}

describe("mergeProjectConfig() keeps every key", () => {
  it.each(Object.keys(LOCAL) as Array<keyof SupatypeProjectConfig>)("keeps %s from the local config", (key) => {
    const merged = mergeProjectConfig(BASE, { [key]: LOCAL[key] })
    expect(merged[key]).toEqual(LOCAL[key])
  })

  it.each(Object.keys(LOCAL) as Array<keyof SupatypeProjectConfig>)("keeps %s from the base config", (key) => {
    const merged = mergeProjectConfig({ ...BASE, [key]: LOCAL[key] }, {})
    expect(merged[key]).toEqual(LOCAL[key])
  })

  it("merges cache, api and publishing a field at a time, preview included", () => {
    const merged = mergeProjectConfig(
      { ...BASE, cache: { provider: "pg_keyspace" }, api: { corsOrigins: ["https://base.example"] },
        publishing: { draft_visibility: ["editor"], preview: { default_ttl: 30, max_record_ttl: 90 } } },
      { cache: { durablePrefixes: ["x:"] }, publishing: { preview: { default_ttl: 60 } } },
    )
    expect(merged.cache).toEqual({ provider: "pg_keyspace", durablePrefixes: ["x:"] })
    expect(merged.api).toEqual({ corsOrigins: ["https://base.example"] })
    expect(merged.publishing).toEqual({ draft_visibility: ["editor"], preview: { default_ttl: 60, max_record_ttl: 90 } })
  })
})
