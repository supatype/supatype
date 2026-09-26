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
