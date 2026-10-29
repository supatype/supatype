---
title: "Schema"
description: "Write Supatype models in TypeScript: field types, relations, access rules, field rules, drafts, slugs, rich text, blocks, storage buckets, renames and what a push refuses."
head:
  - tag: title
    content: "Schema: TypeScript models, access rules and migrations | Supatype"
  - tag: meta
    attrs:
      property: "og:image"
      content: "https://www.supatype.com/og/schema.png"
---

Your schema is a set of TypeScript types in `schema/index.ts`. Supatype builds the tables, access rules, APIs and the typed client from it.

Pre-1.0: APIs and config may change between releases.

<h2 id="models">Models</h2>

Each exported `Model<>` type is a table. Import the types from `@supatype/types`.

Nothing in `schema/index.ts` runs. The CLI reads it as type declarations, so a model is an `export type`, never an `export const`, and there is no builder function to call.

```ts title="schema/index.ts"
import type { Model, UUID, Optional, Public, LoggedIn } from "@supatype/types"

export type Post = Model<{
  id: UUID
  title: string
  published: boolean
  published_at: Optional<string>
}, {
  access: { read: Public; create: LoggedIn; update: LoggedIn; delete: LoggedIn }
}>
```

The table name is the type name in snake case: `Post` becomes `post`, `BlogPost` becomes `blog_post`. Set `tableName` in the second argument to choose another.

An `id: UUID` field becomes the primary key, and the database fills it in.

The second argument also takes `label` and `labelPlural` (names in Studio), `indexes`, `versions` and `singleton: true` (one row, such as site settings).

`supatype dev` applies each save. `supatype push` applies the schema to another database. `supatype diff` shows the change without applying it.

<h2 id="fields">Field types</h2>

Every field is required (`NOT NULL`) unless you wrap it in `Optional<>`. Use `Optional<>`, not `?`.

| Write | Stores |
| --- | --- |
| `string` | text |
| `number`, `Float` | a floating point number |
| `Int`, `SmallInt`, `BigInt`, `Decimal<10, 2>`, `Money` | exact numbers |
| `boolean` | true or false |
| `Timestamp`, `DateTime`, `DateOnly` | a time with zone, or a date |
| `UUID`, `Email`, `URL`, `Color`, `PhoneNumber` | text with a known format |
| `"news" \| "guide"` | an enum of those values |
| `string[]` | an array |
| `JSON<T>` | JSONB, typed as `T` in the client |
| `Vector<1536>` | a pgvector embedding with that many dimensions |
| `RichText`, `Blocks<T>`, `Slug<"title">` | content fields, see [below](#content) |
| `ImageAsset<Bucket>`, `FileAsset` | a file in a storage bucket |
| `SupatypeAuthUserId` | the id of a sign-in user, see [below](#owners) |

Wrap a field to add more: `Unique<T>`, `Indexed<T>`, `Default<T, value>`, `MaxLength<T, n>`, `Between<T, min, max>`.

Three wrappers shape a field in Studio. `EditorReadOnly<T>` is shown but not editable there, and the API can still write it. `Computed<T>` is filled by the database and read-only in Studio. `ComputedFrom<string, "title">` is prefilled from the fields it names on a new record, until the editor changes it.

For translated content, declare the locales once, such as `export type Locales = LocaleConfig<["en", "fr"], "en">`, and wrap a field in `Localized<T>`. It is stored as JSONB keyed by locale: `{ "en": "Hello", "fr": "Bonjour" }`. `LocalizedModel<>` localizes a model's text fields for you, and `NotLocalized<T>` opts one back out. There is no locale setting in `supatype.config.ts`.

Wrap the fields in `WithTimestamps<{ ... }>` to add `created_at` and `updated_at`, which the database fills in.

With the Native provider, `supatype dev` stores `Vector<>` and `Geo` fields as JSONB, because its Postgres has no pgvector or PostGIS. Use Docker to work with them locally.

<h2 id="relations">Relations</h2>

`RelatedTo<Model>` adds a foreign key column named after the field plus `_id`. The field `author` becomes the column `author_id`. The column can be null unless you pass `{ required: true }`.

`onDelete` takes `"cascade"`, `"setNull"`, `"restrict"` or `"noAction"`. It defaults to `"restrict"`: deleting an author with posts is refused.

`HasMany<Model>` and `HasOne<Model>` are the other side of a `RelatedTo`. They add no column. They let the client and seeds reach the related rows.

`ManyToMany<Model>` makes one junction table for the pair, whichever side declares it. It is named from both tables in alphabetical order, so posts and tags share `post_tag`. Pass `{ through: "name" }` to choose the name.

```ts title="schema/index.ts"
import type {
  Model, UUID, SupatypeAuthUserId, Timestamp, RichText, Slug, Unique, Optional, Int,
  RelatedTo, HasMany, ManyToMany, Owner, Role, LoggedIn, Public, Any, Lte, Now,
  Bucket, BucketPublic, BucketLoggedIn, BucketOwner, ImageAsset, Block, Blocks, Default,
} from "@supatype/types"

export type Author = Model<{
  id: SupatypeAuthUserId
  name: string
  bio: Optional<string>
  posts: HasMany<Post>
}, {
  access: { read: Public; create: Owner<"id">; update: Owner<"id">; delete: Owner<"id"> }
}>

export type Tag = Model<{
  id: UUID
  name: Unique<string>
}, {
  access: { read: Public; create: Role<"admin">; update: Role<"admin">; delete: Role<"admin"> }
}>

export type Post = Model<{
  id: UUID
  title: string
  slug: Unique<Slug<"title">>
  body: RichText
  sections: Optional<Blocks<HeroBlock | ProseBlock>>
  kind: "news" | "guide"
  cover: Optional<ImageAsset<Covers>>
  author: RelatedTo<Author, { required: true; onDelete: "cascade" }>
  tags: ManyToMany<Tag>
  comments: HasMany<Comment>
  views: Default<Int, 0>
  published_at: Optional<Timestamp>
}, {
  versions: { drafts: true }
  access: {
    read: Any<[Lte<"published_at", Now>, Owner<"author_id">]>
    create: Owner<"author_id">
    update: Owner<"author_id">
    delete: Any<[Owner<"author_id">, Role<"admin">]>
  }
}>

export type Comment = Model<{
  id: UUID
  post: RelatedTo<Post, { required: true; onDelete: "cascade" }>
  user_id: SupatypeAuthUserId<{ onDelete: "cascade" }>
  body: string
}, {
  access: { read: Public; create: Owner<"user_id">; update: Owner<"user_id">; delete: Owner<"user_id"> }
}>
```

The other pages use this schema in their examples. `HeroBlock`, `ProseBlock` and `Covers` are defined further down.

<h2 id="access">Access rules</h2>

Each model has a rule for `read`, `create`, `update` and `delete`. The rules become Postgres row level security, so they hold for REST, GraphQL, realtime and the client alike.

An operation with no rule is denied. A model with no `access` at all is not reachable through the API.

| Rule | Who passes |
| --- | --- |
| `Public` | Everyone, signed in or not |
| `LoggedIn` | Any signed-in user |
| `Private` | Nobody through the API |
| `Owner<"author_id">` | The user whose id is in that column. Use `"id"`, a `SupatypeAuthUserId` field, or a relation's `_id` column |
| `OwnerFrom<"post">` | The owner of the related row, one relation deep |
| `Role<"admin">` | A user whose `app_metadata.role` is `admin` |
| `Any<[A, B]>`, `All<[A, B]>`, `Not<A>` | Either rule, both rules, or the opposite |
| `Eq`, `Neq`, `Gt`, `Gte`, `Lt`, `Lte`, `Like` | A comparison, such as `Lte<"published_at", Now>` |

In a comparison, a plain string names a column. Wrap a constant in `Literal<>`. `Now`, `AuthUid` and `Claim<"app_metadata.plan">` are also available. `IsNull<"col">` and `NotNull<"col">` test for null.

`Role<>` reads the user's `app_metadata.role`, which only the auth admin API can set. It is not the Studio role.

<h2 id="field-rules">Field rules and masking</h2>

A field rule limits who can read or write one column. Declare it under `access.fields`.

```ts title="schema/index.ts"
export type Profile = Model<{
  id: SupatypeAuthUserId
  display_name: string
  email: string
}, {
  access: {
    read: Public
    create: Owner<"id">
    update: Owner<"id">
    delete: Owner<"id">
    fields: { email: { read: Any<[Owner<"id">, Role<"moderator">]>; write: Owner<"id"> } }
  }
}>
```

A caller who may not read the column still gets the row, with the value masked as `null`. A write the rule refuses fails with error `42501`.

Name a relation by its column, such as `author_id`.

:::note[Not with versions]
A model with `versions` cannot have field rules. Old versions are stored as JSON snapshots, where a column rule cannot be enforced. The schema is refused and the message asks you to drop one of the two.
:::

<h2 id="owners">Auth user ids</h2>

`SupatypeAuthUserId` holds the id of a sign-in user. Use it for owner columns.

When the `create` rule is `Owner<"col">` and the column has no default, the column defaults to the caller's own user id. So a client can leave it out on insert.

By default there is no foreign key to the user. Deleting a user leaves their rows as they were. Add `onDelete` to get one:

| `onDelete` | When the user is deleted |
| --- | --- |
| `"cascade"` | Their rows are deleted too |
| `"restrict"` | Deleting the user is refused while they own rows |
| `"setNull"` | The column is set to null. The field must be `Optional<>` |

The push that adds the key refuses if existing rows name a user that does not exist. Its message says how many rows and how to remove them.

<h2 id="drafts">Drafts and versions</h2>

`versions: { drafts: true }` keeps drafts and a history of each record. `keep` sets how many versions to keep (default 20).

The model's own table holds the published record. That is what `read` rules and the public API see. Drafts and old versions live in `post_versions`.

Publishing copies a draft into the live table. It also sets `published_at` if it is empty. The `update` rule decides who may publish.

A direct API write to the live row is refused. Save a draft with the client's `update`, then publish. See [Client](/docs/client.html#drafts).

`versions: { drafts: false }` keeps history only. Writes go straight to the live row.

Who sees drafts in Studio is set by `publishing.draft_visibility` in `supatype.config.ts`. The default is admin, developer and editor.

<h2 id="content">Slugs, rich text and blocks</h2>

`Slug<"title">` fills itself from `title` when you leave it empty. While it still holds the generated value, it follows the title when the title changes. Set it yourself to keep a URL fixed. Add `Unique<>` if it must be unique.

`RichText` stores a rich text document. When you write, a plain string is accepted and becomes one paragraph. A read always returns the document.

`Blocks<T>` is a list of sections an editor arranges in Studio. Each block is `Block<"name", { fields }>`:

```ts title="schema/index.ts"
export type HeroBlock = Block<"hero", { heading: string; image: Optional<ImageAsset<Covers>> }>
export type ProseBlock = Block<"prose", { body: RichText }>
```

Each entry is stored as `{ "type": "hero", "data": { "heading": "Hi" } }`. A renderer switches on `type` and reads `data`. Rich text inside a block is not converted from a string, so write the full document there.

<h2 id="buckets">Storage buckets</h2>

```ts title="schema/index.ts"
export type Covers = Bucket<"covers", {
  accessMode: "public"
  accept: ["image/png", "image/jpeg", "image/webp"]
  maxSize: "5MB"
  access: { read: BucketPublic; create: BucketLoggedIn; update: BucketOwner; delete: BucketOwner }
}>
```

A bucket has the same four rules as a model. `update` means overwriting a file. The rules are `BucketPublic`, `BucketLoggedIn`, `BucketOwner` (the uploader), `BucketRole<"name">` and `BucketPrivate`.

A rule you leave out is refused for everyone but the service role, and the push warns about it. `accessMode: "public"` serves files on a public URL whatever `read` says.

`ImageAsset<Covers>` on a model stores a reference to a file in that bucket.

<h2 id="renames">Renames</h2>

A push never guesses a rename. Renaming a field in the schema looks like a drop and an add.

In a terminal, `supatype push` asks "Was X renamed to Y?". Answer yes and it records the rename. Without a terminal it stops and prints the command to run.

```sh
$ supatype rename post.title post.headline   # a column
$ supatype rename post article               # a table
```

Renames are recorded in `supatype/renames.json`. Commit it. Every push replays it, so each database gets the same rename. `supatype rename --prune` removes entries the target database has already applied.

:::note[Careful]
`supatype push --yes` does not ask about renames. An unrecorded rename is then pushed as a drop and an add, and the column's data is lost. Record renames first.
:::

<h2 id="push">What a push refuses</h2>

| Push stops when | To go on |
| --- | --- |
| A change can lose data, such as a drop | Answer yes in a terminal, or pass `--yes` in CI |
| A table the schema names exists but Supatype did not create it | `supatype adopt`, or give the model another `tableName`. The push offers to adopt in a terminal |
| Policies, grants or row level security were changed by hand | `--overwrite-drift` puts Supatype's back. To keep the hand edits, run `supatype doctor --rebaseline --accept-access-drift` |
| A versioned model has field rules | Remove one of the two |
| An `onDelete` key would point at missing users | Delete or fix those rows |

`--yes` does not override hand-edited access rules. Only `--overwrite-drift` does. Objects that Supatype did not create are never dropped or taken over.
