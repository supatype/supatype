import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

// `cache` is declared on the model because two of its four settings cannot be checked anywhere
// else. `public` is a data-leak switch whose safety depends on `access.read`, which is right there
// in the same object; `rows` depends on there being a primary key. A Studio checkbox can see
// neither, which is the argument for the declaration existing at all (plan §13.3).

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function extract(body: string): ReturnType<typeof extractSchemaAstFromTypes> {
  const dir = mkdtempSync(join(tmpdir(), "supatype-cache-"))
  dirs.push(dir)
  const schemaPath = join(dir, "schema.ts")
  writeFileSync(
    schemaPath,
    `
import type {
  AuthUid, DateTime, Eq, LoggedIn, Lte, Model, Now, Optional, Owner, Public, Role, UUID,
} from "@supatype/types"

${body}
`,
    "utf8",
  )
  return extractSchemaAstFromTypes(schemaPath, dir)
}

const cacheOf = (ast: ReturnType<typeof extractSchemaAstFromTypes>): unknown =>
  ast?.models[0]?.annotations.platform.cache

describe("the declaration itself", () => {
  it("carries all four settings through", () => {
    const ast = extract(`
export type Post = Model<{
  id: UUID
  title: Slug
}, {
  access: { read: Public }
  cache: { enabled: true; maxTtl: 60; public: true; rows: true }
}>`)
    expect(cacheOf(ast)).toEqual({ enabled: true, maxTtl: 60, public: true, rows: true })
  })

  it("is absent when the model declares none, which is what makes it uncacheable", () => {
    const ast = extract(`
export type Post = Model<{ id: UUID; title: Slug }, { access: { read: Public } }>`)
    expect(cacheOf(ast)).toBeUndefined()
  })

  it("treats an empty block as no declaration rather than an empty ceiling", () => {
    // "Declared but permitting nothing" reads the same as saying nothing, and an empty entry in
    // every manifest is noise a reader has to interpret.
    const ast = extract(`
export type Post = Model<{ id: UUID; title: Slug }, { access: { read: Public }; cache: {} }>`)
    expect(cacheOf(ast)).toBeUndefined()
  })

  it("keeps an explicit false, because it is a hard opt-out and not a default", () => {
    const ast = extract(`
export type Post = Model<{ id: UUID; title: Slug }, {
  access: { read: Public }
  cache: { enabled: false }
}>`)
    expect(cacheOf(ast)).toEqual({ enabled: false })
  })
})

describe("public caching on a caller-varying table", () => {
  it("is refused, naming the model", () => {
    // The check §13.3 calls worth the feature on its own. Nothing else in the system can see both
    // the cache setting and the read rule at once.
    expect(() =>
      extract(`
export type Post = Model<{ id: UUID; user_id: UUID; title: Slug }, {
  access: { read: Owner<"user_id"> }
  cache: { enabled: true; public: true }
}>`),
    ).toThrow(/cache\.public.*varies by caller|varies by caller.*cache\.public/s)
  })

  it("is refused for LoggedIn, which still separates members from strangers", () => {
    expect(() =>
      extract(`
export type Post = Model<{ id: UUID; title: Slug }, {
  access: { read: LoggedIn }
  cache: { enabled: true; public: true }
}>`),
    ).toThrow(/cache\.public/)
  })

  it("is refused when the rule compares a column to the caller", () => {
    expect(() =>
      extract(`
export type Post = Model<{ id: UUID; user_id: UUID; title: Slug }, {
  access: { read: Eq<"user_id", AuthUid> }
  cache: { enabled: true; public: true }
}>`),
    ).toThrow(/cache\.public/)
  })

  it("suggests the fix rather than only refusing", () => {
    let message = ""
    try {
      extract(`
export type Post = Model<{ id: UUID; user_id: UUID; title: Slug }, {
  access: { read: Owner<"user_id"> }
  cache: { enabled: true; public: true }
}>`)
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain("enabled: true")
    expect(message).toContain("published_at")
  })
})

describe("public caching where sharing is the point", () => {
  it("is allowed on a Public read rule", () => {
    const ast = extract(`
export type Post = Model<{ id: UUID; title: Slug }, {
  access: { read: Public }
  cache: { enabled: true; public: true }
}>`)
    expect(cacheOf(ast)).toEqual({ enabled: true, public: true })
  })

  it("is allowed on a rule that varies by row and by time but not by caller", () => {
    // Refusing this would remove the case public caching exists to serve, so it is asserted from
    // the permitting side too — a classifier stuck on "identity-dependent" would pass every test
    // above and fail this one.
    const ast = extract(`
export type Post = Model<{ id: UUID; published_at: Optional<DateTime>; title: Slug }, {
  access: { read: Lte<"published_at", Now> }
  cache: { enabled: true; public: true }
}>`)
    expect(cacheOf(ast)).toEqual({ enabled: true, public: true })
  })

  it("is allowed when public is not asked for, whatever the read rule", () => {
    const ast = extract(`
export type Post = Model<{ id: UUID; user_id: UUID; title: Slug }, {
  access: { read: Owner<"user_id"> }
  cache: { enabled: true }
}>`)
    expect(cacheOf(ast)).toEqual({ enabled: true })
  })
})

describe("the row cache needs something to key on", () => {
  it("refuses rows on a model with no primary key", () => {
    expect(() =>
      extract(`
export type Reading = Model<{ sensor: Slug; value: Slug }, {
  access: { read: Public }
  cache: { enabled: true; rows: true }
}>`),
    ).toThrow(/cache\.rows.*primary key|primary key.*cache\.rows/s)
  })

  it("allows rows where there is a primary key", () => {
    const ast = extract(`
export type Post = Model<{ id: UUID; title: Slug }, {
  access: { read: Public }
  cache: { enabled: true; rows: true }
}>`)
    expect(cacheOf(ast)).toEqual({ enabled: true, rows: true })
  })

  it("says what to do instead of only refusing", () => {
    let message = ""
    try {
      extract(`
export type Reading = Model<{ sensor: Slug; value: Slug }, {
  access: { read: Public }
  cache: { rows: true }
}>`)
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain("response cache")
  })

  it("does not complain about a missing key when rows was not asked for", () => {
    const ast = extract(`
export type Reading = Model<{ sensor: Slug; value: Slug }, {
  access: { read: Public }
  cache: { enabled: true }
}>`)
    expect(cacheOf(ast)).toEqual({ enabled: true })
  })
})
