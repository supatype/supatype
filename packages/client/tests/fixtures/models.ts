/**
 * The schema the test suite declares to `@supatype/client`.
 *
 * Module augmentation is global to a compilation. Once every test file shares one program, a
 * `declare module` block written inside one of them applies to all of them, so a table declared in
 * `types.test.ts` silently constrains `data-plane-auth.test.ts`. That is not a quirk to work
 * around, it is what augmentation is: there is one `SupatypeModels`, and the suite has one schema.
 *
 * So it lives here, covering every table any test queries, rather than in whichever file happened
 * to need it first.
 *
 * Declared with `type` rather than `interface` deliberately. An interface has no implicit index
 * signature, so it does not satisfy `Record<string, unknown>` in `TableDef`, and a fixture written
 * as an interface fails the `AnyDatabase` constraint. Generated output emits type aliases, so this
 * matches what real projects have.
 */

export type Post = {
  id: string
  title: string
  status: "draft" | "published"
  user_id: string
}

export type PostInsert = {
  title: string
  status?: "draft" | "published" | undefined
  user_id: string
}

export type Comment = {
  id: string
  post_id: string
  body: string
}

/** Singular, and distinct from `posts`: several tests query it by that name. */
export type SinglePost = {
  id: string
  title: string
}

export type Author = {
  id: string
  name: string
}

declare module "../../src/types.js" {
  interface SupatypeModels {
    posts: { Row: Post; Insert: PostInsert; Update: Partial<PostInsert> }
    comments: { Row: Comment; Insert: Omit<Comment, "id">; Update: Partial<Comment> }
    post: { Row: SinglePost; Insert: Omit<SinglePost, "id">; Update: Partial<SinglePost> }
    authors: { Row: Author; Insert: Omit<Author, "id">; Update: Partial<Author> }
  }
}
