/**
 * Type inference tests: verify that TypeScript generics produce the correct
 * types throughout the client API.  These assertions are checked at compile
 * time by `tsc -p tsconfig.test.json`. They are NOT checked by `vitest run`: `expectTypeOf` is a
 * no-op at runtime, so a false assertion here passes the test suite and is caught only by the
 * typecheck. This file previously claimed both and was covered by neither.
 */
import { describe, it, expectTypeOf } from "vitest"
import { createClient, QueryBuilder, MutationBuilder } from "../src/index.js"
import type {
  QueryResult,
  SupatypeError,
  TableRow,
  TableInsert,
  TableUpdate,
  SelectError,
  AnyDatabase,
} from "../src/index.js"
// Brings the suite-wide `SupatypeModels` augmentation into this compilation as well as the types.
import type { Post, PostInsert, Comment } from "./fixtures/models.js"
import "./fixtures/models.js"

type TestDB = {
  public: {
    Tables: {
      posts: { Row: Post; Insert: PostInsert; Update: Partial<PostInsert> }
      comments: { Row: Comment; Insert: Omit<Comment, "id">; Update: Partial<Comment> }
    }
  }
}

const client = createClient<TestDB>({ url: "http://localhost:18473", anonKey: "test" })

const augmentedClient = createClient({ url: "http://localhost:18473", anonKey: "test" })

// ─── from() ───────────────────────────────────────────────────────────────────

describe("createClient type inference", () => {
  it("from() infers augmented table types without call-site generics", () => {
    const q = augmentedClient.from("posts").select()
    expectTypeOf(q).toMatchTypeOf<QueryBuilder<Post>>()
  })

  it("from() .select() returns QueryBuilder typed to the table's Row", () => {
    const q = client.from("posts").select()
    expectTypeOf(q).toMatchTypeOf<QueryBuilder<Post>>()
  })

  it("from() .select() with explicit type parameter narrows result type", () => {
    type PostWithComments = Post & { comments: Comment[] }
    const q = client.from("posts").select<PostWithComments>("*, comments(*)")
    expectTypeOf(q).toMatchTypeOf<QueryBuilder<PostWithComments>>()
  })

  it("awaiting QueryBuilder returns QueryResult<Row[]>", () => {
    const q = client.from("posts").select()
    expectTypeOf(q).resolves.toMatchTypeOf<QueryResult<Post[]>>()
  })

  it("from() .insert() accepts Insert type", () => {
    const insert: PostInsert = { title: "Hello", user_id: "u1" }
    const m = client.from("posts").insert(insert)
    expectTypeOf(m).toMatchTypeOf<MutationBuilder<Post>>()
  })

  it("from() .update() returns MutationBuilder<Row>", () => {
    const m = client.from("posts").update({ status: "published" })
    expectTypeOf(m).toMatchTypeOf<MutationBuilder<Post>>()
  })

  it("from() .delete() returns MutationBuilder<Row>", () => {
    const m = client.from("posts").delete()
    expectTypeOf(m).toMatchTypeOf<MutationBuilder<Post>>()
  })
})

// ─── QueryBuilder chaining ─────────────────────────────────────────────────

describe("QueryBuilder chaining preserves type", () => {
  it("chained filters still resolve to QueryResult<Row[]>", () => {
    const q = client
      .from("posts")
      .select()
      .eq("status", "published")
      .order("id")
      .limit(10)
    expectTypeOf(q).resolves.toMatchTypeOf<QueryResult<Post[]>>()
  })

  it(".single() resolves to QueryResult<Row>", async () => {
    // Just type checking: no network call
    const q = client.from("posts").select().single()
    expectTypeOf(q).resolves.toMatchTypeOf<QueryResult<Post>>()
  })

  it(".maybeSingle() resolves to QueryResult<Row | null>", async () => {
    const q = client.from("posts").select().maybeSingle()
    expectTypeOf(q).resolves.toMatchTypeOf<QueryResult<Post | null>>()
  })
})

// ─── SupatypeError ─────────────────────────────────────────────────────────

describe("SupatypeError type", () => {
  it("has required message and optional status and code", () => {
    expectTypeOf<SupatypeError>().toHaveProperty("message")
    expectTypeOf<SupatypeError["message"]>().toEqualTypeOf<string>()
    expectTypeOf<SupatypeError["status"]>().toEqualTypeOf<number | undefined>()
    expectTypeOf<SupatypeError["code"]>().toEqualTypeOf<string | undefined>()
  })
})

// ─── Nested type override ─────────────────────────────────────────────────

describe("Nested relation type override", () => {
  it("explicit generic on select<> sets the resolved element type", () => {
    type Embedded = Post & { comments: Comment[] }
    const q = client.from("posts").select<Embedded>("*, comments(*)")
    // The awaited data should be Embedded[] not Post[]
    expectTypeOf(q).resolves.toMatchTypeOf<QueryResult<Embedded[]>>()
  })
})

// ─── Row and Update helpers ───────────────────────────────────────────────────

describe("table type helpers", () => {
  it("TableRow resolves a table name to its row type", () => {
    // The absence of this is why every example reached into
    // `Database["public"]["Tables"]["post"]["Row"]` by hand.
    expectTypeOf<TableRow<"posts">>().toEqualTypeOf<Post>()
  })

  it("TableInsert resolves to the insert type", () => {
    // Shipped already, and until now had no coverage at all.
    expectTypeOf<TableInsert<"posts">>().toEqualTypeOf<PostInsert>()
  })

  it("TableUpdate resolves to the update type", () => {
    expectTypeOf<TableUpdate<"posts">>().toEqualTypeOf<Partial<PostInsert>>()
  })

  it("distinguishes tables rather than collapsing them", () => {
    // A helper that returned the same shape for every table would satisfy the assertions above.
    expectTypeOf<TableRow<"comments">>().toEqualTypeOf<Comment>()
    expectTypeOf<TableRow<"comments">>().not.toEqualTypeOf<Post>()
  })
})

// ─── select-string inference ──────────────────────────────────────────────────

type Rel<TColumn extends string, TTable extends string, TOne extends boolean = false> = {
  columns: [TColumn]
  isOneToOne: TOne
  referencedRelation: TTable
  referencedColumns: ["id"]
}

type Author_ = { id: string; name: string }
type Article = { id: string; title: string; author_id: string; editor_id: string | null }
type Label = { id: string; text: string }
type Profile = { id: string; author_id: string; bio: string }

type JoinDB = {
  public: {
    Tables: {
      authors: { Row: Author_; Insert: Author_; Update: Partial<Author_>; Relationships: [] }
      articles: {
        Row: Article
        Insert: Article
        Update: Partial<Article>
        Relationships: [Rel<"author_id", "authors">, Rel<"editor_id", "authors">]
      }
      labels: { Row: Label; Insert: Label; Update: Partial<Label>; Relationships: [] }
      article_labels: {
        Row: { article_id: string; label_id: string }
        Insert: { article_id: string; label_id: string }
        Update: { article_id?: string; label_id?: string }
        Relationships: [Rel<"article_id", "articles">, Rel<"label_id", "labels">]
      }
      profiles: {
        Row: Profile
        Insert: Profile
        Update: Partial<Profile>
        Relationships: [Rel<"author_id", "authors", true>]
      }
    }
  }
}

const joins = createClient<JoinDB>({ url: "http://localhost:18473", anonKey: "test" })

type RowOf<Q> = Q extends QueryBuilder<infer R> ? R : never

describe("select-string inference", () => {
  it("picks and aliases columns", () => {
    const q = joins.from("articles").select("id, heading:title")
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{ id: string; heading: string }>()
  })

  it("types * as the row itself", () => {
    expectTypeOf(joins.from("articles").select("*")).toEqualTypeOf<QueryBuilder<Article>>()
    expectTypeOf(joins.from("articles").select()).toEqualTypeOf<QueryBuilder<Article>>()
  })

  it("embeds a to-one relation as the row or null, and !inner as the row", () => {
    const q = joins.from("articles").select("id, author:authors!author_id(name)")
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{ id: string; author: { name: string } | null }>()
    const inner = joins.from("articles").select("author:authors!author_id!inner(*)")
    expectTypeOf<RowOf<typeof inner>>().toEqualTypeOf<{ author: Author_ }>()
  })

  it("embeds the other side of a key as many rows, or one when the key is unique", () => {
    const q = joins.from("authors").select("name, articles(title), profiles(bio)")
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{
      name: string
      articles: Array<{ title: string }>
      profiles: { bio: string } | null
    }>()
  })

  it("embeds through a junction, directly or by naming it", () => {
    const direct = joins.from("articles").select("labels(text)")
    expectTypeOf<RowOf<typeof direct>>().toEqualTypeOf<{ labels: Array<{ text: string }> }>()
    const named = joins.from("articles").select("article_labels(label:labels(*))")
    expectTypeOf<RowOf<typeof named>>().toEqualTypeOf<{
      article_labels: Array<{ label: Label | null }>
    }>()
  })

  it("reads JSON paths and casts as unknown values keyed by their last name", () => {
    const q = joins.from("articles").select("id::text, title->>en")
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{ id: unknown; en: unknown }>()
  })

  it("puts the reason in the type when a name does not resolve", () => {
    const q = joins.from("articles").select("nope, writer:writers(*)")
    expectTypeOf<RowOf<typeof q>["nope"]>().toEqualTypeOf<
      SelectError<"column 'nope' does not exist on 'articles'">
    >()
    expectTypeOf<RowOf<typeof q>["writer"]>().toEqualTypeOf<SelectError<"'writers' is not a table">>()
  })

  it("leaves an untyped database's embeds unknown rather than refusing them", () => {
    const loose = createClient<AnyDatabase>({ url: "http://localhost:18473", anonKey: "test" })
    const q = loose.from("anything").select("id, other(*)")
    expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{ id: unknown; other: unknown }>()
  })
})

type WrittenRow<M> = M extends PromiseLike<QueryResult<Array<infer R>>> ? R : never

describe("select-string inference after a write", () => {
  it("types the returned rows from the string on insert, update, upsert and delete", () => {
    const row: Article = { id: "a", title: "t", author_id: "u", editor_id: null }
    const inserted = joins.from("articles").insert(row).select("id, heading:title")
    expectTypeOf<WrittenRow<typeof inserted>>().toEqualTypeOf<{ id: string; heading: string }>()
    const updated = joins.from("articles").update({ title: "u" }).eq("id", "a").select("title")
    expectTypeOf<WrittenRow<typeof updated>>().toEqualTypeOf<{ title: string }>()
    const upserted = joins.from("articles").upsert(row).select("author:authors!author_id(name)")
    expectTypeOf<WrittenRow<typeof upserted>>().toEqualTypeOf<{ author: { name: string } | null }>()
    const deleted = joins.from("articles").delete().eq("id", "a").select("id")
    expectTypeOf<WrittenRow<typeof deleted>>().toEqualTypeOf<{ id: string }>()
  })

  it("keeps the whole row for no argument and for *", () => {
    const row: Article = { id: "a", title: "t", author_id: "u", editor_id: null }
    const bare = joins.from("articles").insert(row).select()
    expectTypeOf<WrittenRow<typeof bare>>().toEqualTypeOf<Article>()
    const star = joins.from("articles").update({ title: "u" }).select("*")
    expectTypeOf<WrittenRow<typeof star>>().toEqualTypeOf<Article>()
  })

  it("lets an explicit type parameter override the string", () => {
    type Custom = { id: string; extra: number }
    const q = joins.from("articles").delete().select<Custom>("id, extra")
    expectTypeOf<WrittenRow<typeof q>>().toEqualTypeOf<Custom>()
  })

  it("narrows .single() after a select", () => {
    const q = joins.from("articles").update({ title: "u" }).eq("id", "a").select("id").single()
    expectTypeOf(q).resolves.toEqualTypeOf<QueryResult<{ id: string }>>()
  })
})
