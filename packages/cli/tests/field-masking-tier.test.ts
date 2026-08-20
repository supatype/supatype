import { describe, it, expect } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  fieldMaskingTier,
  imageShipsMaskExtension,
  nativeMaskLibraryPresent,
  schemaHasFieldRules,
} from "../src/field-masking-tier.js"
import { apiSchemaList, validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"

/**
 * Which mechanism will enforce per-column rules, decided without touching the database.
 *
 * The engine decides the same thing at push time by asking Postgres whether `supatype_mask` is
 * installed. The CLI has to answer earlier, because it writes `PGRST_DB_SCHEMA` when it generates
 * compose. It can, because the extension needs `shared_preload_libraries` and a compiled library on
 * the host: exactly one path ships it.
 *
 * The rule is deliberately **not** "is the database external". A native `supatype dev` has no
 * extension either, and calling that tier 1 would point PostgREST at a schema whose tables the API
 * roles no longer hold privileges on, every request denied.
 */
const project = (database: unknown, rest: Record<string, unknown> = {}): SupatypeProjectConfig =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      database,
      server: { mode: "dev" },
      app: { mode: "none" },
      ...rest,
    },
    "supatype.config.ts",
  )

const withRules = {
  models: [
    {
      annotations: {
        db: { tableName: "employee" },
        platform: { access: { fields: { salary: { read: { type: "private" } } } } },
      },
    },
  ],
}
const withoutRules = {
  models: [{ annotations: { db: { tableName: "employee" }, platform: { access: {} } } }],
}

describe("imageShipsMaskExtension", () => {
  it("is true only for the Supatype Postgres image", () => {
    expect(imageShipsMaskExtension(project({ provider: "docker" }))).toBe(true)
  })

  it("is false for native, which is the default `supatype dev`", () => {
    // The case that makes "is it external" the wrong rule.
    expect(imageShipsMaskExtension(project({ provider: "native" }))).toBe(false)
  })

  it("is false for an external database", () => {
    expect(
      imageShipsMaskExtension(project({ external: { url: "postgres://u@h:5432/d" } })),
    ).toBe(false)
  })

  it("is false when the Postgres image is overridden", () => {
    // Someone running plain `postgres:17` under `provider: docker` has no extension, whatever the
    // provider says.
    expect(imageShipsMaskExtension(project({ provider: "docker", image: "postgres:17" }))).toBe(
      false,
    )
    expect(
      imageShipsMaskExtension(project({ provider: "docker", image: "supatype/postgres:17-latest" })),
    ).toBe(true)
  })
})

describe("schemaHasFieldRules", () => {
  it("sees a masked column", () => {
    expect(schemaHasFieldRules(withRules)).toBe(true)
  })

  it("is false without one, and for anything unexpected", () => {
    expect(schemaHasFieldRules(withoutRules)).toBe(false)
    expect(schemaHasFieldRules({ models: [] })).toBe(false)
    expect(schemaHasFieldRules(null)).toBe(false)
    expect(schemaHasFieldRules({})).toBe(false)
  })

  it("is false for an empty fields map", () => {
    // Present but empty means no column is masked, so nothing needs a view.
    const empty = {
      models: [{ annotations: { platform: { access: { fields: {} } } } }],
    }
    expect(schemaHasFieldRules(empty)).toBe(false)
  })
})

describe("fieldMaskingTier", () => {
  it("is none when nothing is masked, whatever the database", () => {
    // With no field rules the engine generates no views, so pointing the API at `api` would serve
    // nothing at all.
    expect(fieldMaskingTier(project({ provider: "native" }), withoutRules)).toBe("none")
    expect(fieldMaskingTier(project({ provider: "docker" }), withoutRules)).toBe("none")
  })

  it("is extension on the image and views everywhere else", () => {
    expect(fieldMaskingTier(project({ provider: "docker" }), withRules)).toBe("extension")
    expect(fieldMaskingTier(project({ provider: "native" }), withRules)).toBe("views")
    expect(
      fieldMaskingTier(project({ external: { url: "postgres://u@h:5432/d" } }), withRules),
    ).toBe("views")
  })
})

describe("the exposed schema list", () => {
  it("serves from api under tier 2, and drops the managed schema", () => {
    // Both halves matter. A client picks its schema per request with `Accept-Profile`, so leaving the
    // managed schema exposed would let any caller read the unmasked table.
    const list = apiSchemaList(project({ provider: "native" }), "views")
    expect(list).toBe("api, supatype, graphql_public, auth")
    // Entries, not substrings: `graphql_public` legitimately contains "public".
    expect(list.split(", ")).not.toContain("public")
  })

  it("is unchanged for tier 1 and for a schema with no field rules", () => {
    for (const tier of ["extension", "none", undefined] as const) {
      expect(apiSchemaList(project({ provider: "docker" }), tier)).toBe(
        "public, supatype, graphql_public, auth",
      )
    }
  })

  it("still lets an explicit api_schemas win", () => {
    // The escape hatch for the one case the offline rule cannot call: a self-managed Postgres where
    // the operator installed the extension themselves.
    const cfg = project({ external: { url: "postgres://u@h:5432/d" } }, {
      schema: { api_schemas: ["public", "supatype"] },
    })
    expect(apiSchemaList(cfg, "views")).toBe("public, supatype")
  })
})

describe("nativeMaskLibraryPresent", () => {
  it("is false for an install without the library", () => {
    // The case that must not be assumed away: an archive downloaded before the library was bundled.
    // Claiming tier 1 for it would select the planner rewrite and the push would be refused.
    const dir = mkdtempSync(join(tmpdir(), "supatype-pg-"))
    mkdirSync(join(dir, "bin"), { recursive: true })
    mkdirSync(join(dir, "lib", "postgresql"), { recursive: true })
    expect(nativeMaskLibraryPresent(join(dir, "bin"))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it("finds the library in either archive layout", () => {
    // Linux and macOS put extension libraries in `lib/`; the Windows archive uses `lib/postgresql/`.
    for (const [subdir, lib] of [
      [["lib"], "supatype_mask.so"],
      [["lib"], "supatype_mask.dylib"],
      [["lib", "postgresql"], "supatype_mask.dll"],
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), "supatype-pg-"))
      mkdirSync(join(dir, "bin"), { recursive: true })
      mkdirSync(join(dir, ...subdir), { recursive: true })
      writeFileSync(join(dir, ...subdir, lib), "")
      expect(nativeMaskLibraryPresent(join(dir, "bin")), lib).toBe(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is false without an install directory at all", () => {
    expect(nativeMaskLibraryPresent(null)).toBe(false)
    expect(nativeMaskLibraryPresent(undefined)).toBe(false)
  })

  it("selects the extension tier when the library is installed", () => {
    // The point of the whole change: native dev enforces field rules the same way the image does.
    expect(fieldMaskingTier(project({ provider: "native" }), withRules, true)).toBe("extension")
    expect(fieldMaskingTier(project({ provider: "native" }), withRules, false)).toBe("views")
    // Still nothing to enforce when no column is masked.
    expect(fieldMaskingTier(project({ provider: "native" }), withoutRules, true)).toBe("none")
  })
})
