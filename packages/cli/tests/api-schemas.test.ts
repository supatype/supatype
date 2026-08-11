import { describe, it, expect } from "vitest"
import {
  apiSchemaList,
  apiSchemas,
  pgSchema,
  type SupatypeProjectConfig,
} from "../src/project-config.js"

/**
 * `PGRST_DB_SCHEMA` used to be a literal in two places, so `schema.pg_schema` was honoured by the
 * engine and ignored by the API: a project pushed into its own schema and then answered PGRST106 on
 * every request, with nothing in the output naming the setting responsible.
 */
const project = (schema?: SupatypeProjectConfig["schema"]): SupatypeProjectConfig => ({
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
  ...(schema !== undefined && { schema }),
})

describe("pgSchema", () => {
  it("defaults to public", () => {
    expect(pgSchema(project())).toBe("public")
    expect(pgSchema(project({}))).toBe("public")
  })

  it("ignores a blank pg_schema rather than emitting an empty identifier", () => {
    expect(pgSchema(project({ pg_schema: "   " }))).toBe("public")
  })
})

describe("apiSchemas", () => {
  it("reproduces the list self-host shipped before it was configurable", () => {
    expect(apiSchemaList(project())).toBe("public, supatype, graphql_public, auth")
  })

  it("is the same list for dev and self-host", () => {
    // Dev used to omit `auth`, so a request that worked against a self-hosted stack 404ed locally.
    expect(apiSchemas(project())).toContain("auth")
  })

  it("leads with the managed schema when pg_schema moves", () => {
    // First entry is what PostgREST serves as the default profile, so the managed schema has to
    // lead — otherwise unprefixed requests would resolve against `supatype`.
    expect(apiSchemaList(project({ pg_schema: "app" }))).toBe(
      "app, supatype, graphql_public, auth",
    )
  })

  it("does not repeat a stack schema the project has chosen to manage", () => {
    expect(apiSchemas(project({ pg_schema: "supatype" }))).toEqual([
      "supatype",
      "graphql_public",
      "auth",
    ])
  })

  it("lets an explicit list replace the whole thing, stack schemas included", () => {
    // The point of making the entire list configurable: dropping `supatype` is a supported way to
    // stop exposing Studio's views over REST.
    expect(apiSchemas(project({ pg_schema: "app", api_schemas: ["app"] }))).toEqual(["app"])
  })

  it("preserves the order given, since order selects the default profile", () => {
    expect(apiSchemaList(project({ api_schemas: ["reporting", "app"] }))).toBe("reporting, app")
  })

  it("falls back to the derived list when api_schemas is present but empty", () => {
    // An empty PGRST_DB_SCHEMA makes PostgREST refuse to start; a truncated config should not be
    // the reason the API is down.
    expect(apiSchemaList(project({ pg_schema: "app", api_schemas: [] }))).toBe(
      "app, supatype, graphql_public, auth",
    )
  })

  it("drops blank and duplicate entries", () => {
    expect(apiSchemas(project({ api_schemas: ["app", " ", "app", " reporting "] }))).toEqual([
      "app",
      "reporting",
    ])
  })
})
