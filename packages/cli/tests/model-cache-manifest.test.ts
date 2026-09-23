import { describe, expect, it } from "vitest"
import { manifestCache } from "../src/model-cache.js"

// The declaration reaches the server on the route manifest, keyed by table, exactly as `hooks`
// does — and for the same reason. The schema engine re-serialises its own parsed struct when it
// writes `ast_snapshot`, and its platform annotations know only `access` and `searchFields`, so a
// `cache` key left to ride the AST is dropped in silence somewhere between push and the server.

function ast(models: unknown[]): unknown {
  return { models }
}

function model(table: string, cache?: unknown): unknown {
  return {
    name: table,
    annotations: { db: { tableName: table }, platform: { ...(cache !== undefined && { cache }) } },
  }
}

describe("what reaches the manifest", () => {
  it("keys by table, not by model name", () => {
    // The model name never reaches the wire; a REST path carries the table.
    const out = manifestCache(
      ast([
        {
          name: "BlogPost",
          annotations: { db: { tableName: "blog_posts" }, platform: { cache: { enabled: true } } },
        },
      ]),
    )
    expect(out).toEqual({ blog_posts: { enabled: true } })
  })

  it("carries all four settings", () => {
    const out = manifestCache(ast([model("posts", { enabled: true, maxTtl: 60, public: true, rows: true })]))
    expect(out).toEqual({ posts: { enabled: true, maxTtl: 60, public: true, rows: true } })
  })

  it("omits a model that declared nothing, rather than writing an empty entry", () => {
    // Load-bearing: the declaration is a ceiling, so absence means nothing may cache this table.
    // An empty entry would say "declared, permitting nothing" — the same outcome by a route that
    // looks like a bug.
    expect(manifestCache(ast([model("posts")]))).toEqual({})
  })

  it("keeps an explicit false, which is a hard opt-out and not silence", () => {
    expect(manifestCache(ast([model("posts", { enabled: false })]))).toEqual({
      posts: { enabled: false },
    })
  })

  it("carries maxTtl of zero, which means cache nothing rather than no opinion", () => {
    expect(manifestCache(ast([model("posts", { maxTtl: 0 })]))).toEqual({ posts: { maxTtl: 0 } })
  })
})

describe("what does not reach the manifest", () => {
  it("drops keys the AST shape does not define", () => {
    // Copied key by key on purpose. The manifest is a wire format another process parses, and
    // widening it by accident is how the two ends stop agreeing what a field means.
    const out = manifestCache(ast([model("posts", { enabled: true, somethingNew: true })]))
    expect(out).toEqual({ posts: { enabled: true } })
  })

  it("drops a non-numeric or negative maxTtl rather than passing it on", () => {
    expect(manifestCache(ast([model("a", { maxTtl: "60" })]))).toEqual({})
    expect(manifestCache(ast([model("b", { maxTtl: -1 })]))).toEqual({})
    expect(manifestCache(ast([model("c", { maxTtl: Number.NaN })]))).toEqual({})
    expect(manifestCache(ast([model("d", { maxTtl: Number.POSITIVE_INFINITY })]))).toEqual({})
  })

  it("drops a non-boolean flag", () => {
    expect(manifestCache(ast([model("posts", { enabled: "yes", rows: 1 })]))).toEqual({})
  })

  it("skips a model with no table name", () => {
    expect(
      manifestCache(ast([{ name: "X", annotations: { platform: { cache: { enabled: true } } } }])),
    ).toEqual({})
  })
})

describe("shapes that should not throw", () => {
  it("survives an AST that is not one", () => {
    expect(manifestCache(null)).toEqual({})
    expect(manifestCache({})).toEqual({})
    expect(manifestCache({ models: "not an array" })).toEqual({})
  })

  it("survives a model with no annotations at all", () => {
    expect(manifestCache(ast([{ name: "X" }, null, 7]))).toEqual({})
  })

  it("survives a null cache", () => {
    expect(
      manifestCache(ast([{ annotations: { db: { tableName: "t" }, platform: { cache: null } } }])),
    ).toEqual({})
  })
})
