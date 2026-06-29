<p align="center">
  <img src="https://raw.githubusercontent.com/supatype/.github/refs/heads/main/profile/supatype-icon.svg" width="60" alt="Supatype" />
</p>

# @supatype/types

Pure TypeScript type primitives for [Supatype](https://github.com/supatype/supatype) — the type-first platform for PostgreSQL.

Define your schema once in TypeScript. The CLI reads these types to generate migrations, RLS policies, and a typed client — no separate schema language required.

## Installation

```bash
npm i @supatype/types
```

## Usage

```ts
import type {
  Model,
  UUID,
  Email,
  Slug,
  RichText,
  Optional,
  RelatedTo,
  HasMany,
  Timestamps,
  LoggedIn,
  Owner,
} from "@supatype/types"

export type Author = Model<{
  id: UUID
  name: string
  email: Email
  posts: HasMany<Post>
} & Timestamps>

export type Post = Model<
  {
    id: UUID
    slug: Slug
    title: string
    body: RichText
    coverImage: Optional<string>
    author: RelatedTo<Author>
  } & Timestamps,
  {
    access: {
      read: LoggedIn
      create: Owner<"author_id">
      update: Owner<"author_id">
      delete: Owner<"author_id">
    }
  }
>
```

## Primitive types

Branded column types that map directly to Postgres data types:

| Type | Postgres | TS shape |
|------|----------|----------|
| `UUID` | `uuid` | `string` |
| `Email` | `text` | `string` |
| `URL` | `text` | `string` |
| `Slug<Source?>` | `text` | `string` |
| `PhoneNumber` | `text` | `string` |
| `Markdown` | `text` | `string` |
| `Color` | `text` | `string` |
| `Int` | `integer` | `number` |
| `SmallInt` | `smallint` | `number` |
| `BigInt` | `bigint` | `bigint` |
| `Float` | `float8` | `number` |
| `Decimal<P, S>` | `numeric(P,S)` | `string` |
| `Money` | `numeric` | `string` |
| `Vector<N>` | `vector(N)` | `number[]` |
| `DateOnly` | `date` | `Date` |
| `DateTime` | `timestamptz` | `Date` |
| `Timestamp` | `timestamptz` | `Date` |
| `IPAddress` | `inet` | `string` |
| `JSON<T>` | `jsonb` | `T` |
| `RichText` | `jsonb` | `SerializedEditorState \| string` |
| `Button` | `jsonb` | `ButtonValue` |
| `GeoPoint` | `jsonb` | `{ lat: number; lng: number }` |
| `Duration` | `jsonb` | `{ ms: number }` |

## Modifiers

Wrap any field type to add constraints or behaviour:

```ts
Optional<T>           // nullable column (key?: T | null)
Unique<T>             // UNIQUE constraint
Indexed<T>            // CREATE INDEX
Searchable<T>         // full-text search index
Default<T, Value>     // column default
ServerDefault<T>      // DB-assigned (omitted from Insert)
AutoIncrement<T>      // SERIAL / IDENTITY
PrimaryKey<T>         // PRIMARY KEY
MaxLength<T, N>       // CHECK (length <= N)
MinLength<T, N>       // CHECK (length >= N)
Between<T, Min, Max>  // CHECK constraint
Computed<T>           // trigger/expression, read-only in Studio
ComputedFrom<T, Sources>  // Studio preview built from source fields
Localized<T>          // JSONB locale map { "en": …, "de": … }
NotLocalized<T>       // opt out of LocalizedModel auto-localization
EditorReadOnly<T>     // visible but not editable in Studio
```

## Relations

```ts
RelatedTo<T, Options?>   // foreign key column
HasMany<T, Options?>     // reverse of RelatedTo
HasOne<T, Options?>      // one-to-one reverse
ManyToMany<T, Options?>  // join table
```

`RelationOptions`: `required?`, `onDelete?` (`"cascade" | "setNull" | "restrict" | "noAction"`), `inverse?`

## Access control (RLS)

```ts
Public       // no auth required
Private      // blocked by default
LoggedIn     // any authenticated user
Owner<Model, Key>      // row belongs to authenticated user
OwnerFrom<RelationField>  // ownership via relation
Role<"admin">          // custom Postgres role
```

Set per-operation on the model's second type argument:

```ts
type Post = Model<Fields, {
  access: {
    read: LoggedIn
    create: LoggedIn
    update: Owner<Post, "author_id">
    delete: Owner<Post, "author_id">
  }
}>
```

## Model utilities

```ts
// Audit timestamps (created_at, updated_at with DB defaults)
type Post = Model<{ … } & Timestamps>

// Soft delete (deleted_at nullable column)
type Post = Model<{ … } & SoftDelete>

// Publishable (published_at nullable column)
type Post = Model<{ … } & Publishable>

// Auto-localize copy fields (string, RichText, Markdown, Button)
type Post = LocalizedModel<{ title: string; body: RichText }>

// Singleton global (one row, Studio Globals UI)
type SiteSettings = Model<Fields, GlobalMeta<Fields>>
```

## Storage

```ts
import type { Bucket, ImageAsset, FileAsset, BucketPublic, BucketOwner } from "@supatype/types"

export type AvatarBucket = Bucket<"avatars", {
  accessMode: "private"
  maxSize: "5MB"
  accept: readonly ["image/*"]
  access: { read: BucketOwner; create: BucketOwner }
}>

type UserProfile = Model<{
  id: UUID
  avatar: Optional<ImageAsset<AvatarBucket>>
}>
```

## Blocks (structured content)

```ts
import type { Block, Blocks } from "@supatype/types"

type HeroBlock = Block<"hero", { heading: string; subheading: Optional<string> }>
type ImageBlock = Block<"image", { src: string; alt: string }>

type Page = Model<{
  id: UUID
  content: Blocks<HeroBlock | ImageBlock>
}>
```

## Docs

Full documentation: [supatype.github.io/supatype](https://supatype.github.io/supatype/)
