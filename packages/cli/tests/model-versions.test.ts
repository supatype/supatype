import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"
import {
  DEFAULT_VERSIONS_KEPT,
  modelsWithVersionsAndFieldRules,
  resolveVersionsOptions,
  schemaHasVersionedModels,
  versionedModels,
} from "../src/model-versioning.js"
import { apiSchemaList, draftVisibilityRoles, previewLimits } from "../src/project-config.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

// A versioned model is opt-in and changes three things that are decided before any database exists:
// the exposed schema list gains `draft`, the engine emits a versions table and a draft view, and a
// model that also masks a column is refused. All three read `versions` out of the extracted AST, so
// what the extractor puts there is the contract these tests pin.

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function extract(body: string): ReturnType<typeof extractSchemaAstFromTypes> {
  const dir = mkdtempSync(join(tmpdir(), "supatype-versions-"))
  dirs.push(dir)
  const schemaPath = join(dir, "schema.ts")
  writeFileSync(
    schemaPath,
    `
import type {
  Lte, Model, Now, Optional, Owner, Public, RichText, Role, Timestamp, UUID,
} from "@supatype/types"

${body}
`,
    "utf8",
  )
  return extractSchemaAstFromTypes(schemaPath, dir)
}

const POST = `
export type Post = Model<{
  id: UUID
  title: string
  body: RichText
  published_at: Optional<Timestamp>
}, {
  tableName: "posts"
  versions: { drafts: true; keep: 5 }
  access: { read: Lte<"published_at", Now>; update: Role<"editor"> }
}>
`

describe("the versions declaration", () => {
  it("reaches the AST with its retention", () => {
    const ast = extract(POST)
    expect(ast?.models[0]?.options["versions"]).toEqual({ drafts: true, keep: 5 })
  })

  it("takes `true` as shorthand for drafts with the default retention", () => {
    const ast = extract(`
export type Note = Model<{ id: UUID; title: string }, { versions: true }>
`)
    expect(ast?.models[0]?.options["versions"]).toEqual({
      drafts: true,
      keep: DEFAULT_VERSIONS_KEPT,
    })
  })

  it("keeps history without withholding writes when drafts are off", () => {
    // The audit-trail case: every change recorded, nothing hidden from readers.
    const ast = extract(`
export type Ledger = Model<{ id: UUID; note: string }, { versions: { drafts: false } }>
`)
    expect(ast?.models[0]?.options["versions"]).toEqual({
      drafts: false,
      keep: DEFAULT_VERSIONS_KEPT,
    })
  })

  it("is absent from a model that does not declare it", () => {
    const ast = extract(`export type Plain = Model<{ id: UUID; title: string }>`)
    expect(ast?.models[0]?.options["versions"]).toBeUndefined()
    expect(schemaHasVersionedModels(ast)).toBe(false)
  })

  it("names the model and its table, which is what the generated relations are named after", () => {
    const found = versionedModels(extract(POST))
    expect(found).toEqual([
      { name: "Post", tableName: "posts", options: { drafts: true, keep: 5 } },
    ])
  })
})

describe("versions alongside per-column rules", () => {
  it("refuses the pair, naming the masked column", () => {
    // A snapshot is opaque JSONB, so the masking that rewrites references to a real column cannot
    // see inside it: the value would be readable in the versions table.
    expect(() =>
      extract(`
export type Employee = Model<{ id: UUID; name: string; salary: number }, {
  versions: true
  access: { read: Public; fields: { salary: { read: Owner<"id"> } } }
}>
`),
    ).toThrow(/`versions` and `access.fields` cannot both be declared[\s\S]*`salary`/)
  })

  it("allows a masked model and a versioned model in the same schema", () => {
    // Per model, not per project. Under the view tier the managed schema comes off the exposed list
    // but the API roles keep their privileges on the base tables, so a `security_invoker` view in an
    // exposed schema reaches past the `api` layer: one model may not be both, a project may hold
    // both.
    const ast = extract(`
export type Employee = Model<{ id: UUID; name: string; salary: number }, {
  access: { read: Public; fields: { salary: { read: Owner<"id"> } } }
}>

export type Article = Model<{ id: UUID; title: string }, { versions: true }>
`)
    expect(ast?.models).toHaveLength(2)
    expect(schemaHasVersionedModels(ast)).toBe(true)
    expect(modelsWithVersionsAndFieldRules(ast)).toEqual([])
  })
})

describe("resolveVersionsOptions", () => {
  it("treats a retention of zero as unstated, since pruning to nothing deletes the open draft", () => {
    expect(resolveVersionsOptions({ keep: 0 })).toEqual({
      drafts: true,
      keep: DEFAULT_VERSIONS_KEPT,
    })
  })

  it("reads `false` and a non-object as no versioning at all", () => {
    expect(resolveVersionsOptions(false)).toBeUndefined()
    expect(resolveVersionsOptions(undefined)).toBeUndefined()
    expect(resolveVersionsOptions("true")).toBeUndefined()
  })
})

function project(overrides?: Partial<SupatypeProjectConfig>): SupatypeProjectConfig {
  return {
    projectName: "test",
    database: { provider: "docker" },
    ...overrides,
  } as SupatypeProjectConfig
}

describe("the exposed schema list with drafts", () => {
  it("adds `draft` behind the managed schema, never in front of it", () => {
    // The first entry is PostgREST's default profile. `draft` leading would mean a client that named
    // no profile read drafts by default, which inverts the whole feature.
    expect(apiSchemaList(project(), { drafts: true })).toBe(
      "public, draft, supatype, graphql_public, auth",
    )
  })

  it("is unchanged when nothing is versioned", () => {
    expect(apiSchemaList(project(), { drafts: false })).toBe(
      "public, supatype, graphql_public, auth",
    )
  })

  it("still lets an explicit api_schemas win, drafts or not", () => {
    // Stating the list is the documented way to stop exposing a schema, and that has to hold for
    // `draft` as much as for `supatype`.
    const cfg = project({ schema: { api_schemas: ["public"] } })
    expect(apiSchemaList(cfg, { drafts: true })).toBe("public")
  })

  it("serves drafts from the managed schema even under the view tier", () => {
    // The draft views read the real tables, so tier 2 moving reads to `api` does not move them.
    expect(apiSchemaList(project(), { tier: "views", drafts: true })).toBe(
      "api, draft, supatype, graphql_public, auth",
    )
  })
})

describe("draft visibility", () => {
  it("defaults to every Studio role, so seeing and acting line up", () => {
    // Narrower than this put two decisions in conflict: whoever may update a record may draft it,
    // so a role that can edit but cannot see drafts saves over a colleague's pending work.
    expect(draftVisibilityRoles(project())).toEqual(["admin", "developer", "editor"])
  })

  it("honours an empty list as creators only", () => {
    // Not a fallback case: narrowing to creators alone is a legitimate setting, so emptiness cannot
    // mean "unstated".
    expect(draftVisibilityRoles(project({ publishing: { draft_visibility: [] } }))).toEqual([])
  })

  it("drops a role no deployment understands", () => {
    // A typo passed through to a policy would be a role nothing can hold, which reads as a working
    // setting that grants nobody.
    const cfg = project({
      publishing: { draft_visibility: ["editor", "owner", "editor"] as never },
    })
    expect(draftVisibilityRoles(cfg)).toEqual(["editor"])
  })
})

describe("preview limits", () => {
  it("defaults to a short link, a week for a record and a day for a project", () => {
    expect(previewLimits(project())).toEqual({
      defaultTtl: 900,
      maxRecordTtl: 604800,
      maxProjectTtl: 86400,
      allowProjectScope: true,
    })
  })

  it("clamps a default lifetime above every ceiling it could be issued against", () => {
    // Otherwise the same config mints links it then refuses to honour.
    const cfg = project({
      publishing: { preview: { default_ttl: 999999, max_record_ttl: 3600, max_project_ttl: 600 } },
    })
    expect(previewLimits(cfg).defaultTtl).toBe(3600)
  })

  it("ignores a nonsense lifetime rather than issuing a link that has already expired", () => {
    const cfg = project({ publishing: { preview: { default_ttl: 0 } } })
    expect(previewLimits(cfg).defaultTtl).toBe(900)
  })
})
