# Schema reference

Schema is **type-first**: `schema/index.ts` is the source of truth. Define models with `@supatype/types`; the engine diffs against Postgres on `supatype push`.

Do **not** use legacy `@supatype/schema` builder API. Do **not** hand-edit generated type files.

## Basic model

```typescript
import type {
  Model, Public, Private, LoggedIn, Owner, Role,
  SupatypeAuthUserId, Unique, Email, UUID, Timestamp,
} from "@supatype/types"

export type User = Model<{
  id: SupatypeAuthUserId
  email: Unique<Email>
  name: string
  created_at: Timestamp
  updated_at: Timestamp
}, {
  access: {
    read: Public
    create: Public
    update: Owner<"id">
    delete: Role<"admin">
  }
}>
```

## Access rules

| Type | Meaning |
|------|---------|
| `Public` | Anyone (including anon) |
| `Private` | No direct API access |
| `LoggedIn` | Authenticated users |
| `Owner<"field">` | Row owner via field (often `"id"`) |
| `OwnerFrom<"relation">` | Owner via related model |
| `Role<"admin">` | Users with named role |

Define `access` per operation: `read`, `create`, `update`, `delete`.

## Relations

```typescript
import type { RelatedTo, Optional } from "@supatype/types"

export type Post = Model<{
  id: UUID
  title: string
  author: RelatedTo<"User">
  author_id: UUID
  published_at: Optional<Timestamp>
}, {
  access: {
    read: Public
    create: LoggedIn
    update: OwnerFrom<"author">
    delete: OwnerFrom<"author">
  }
}>
```

Relation kinds: `RelatedTo`, `HasMany`, `HasOne`, `ManyToMany` (from `@supatype/types`).

## Singleton globals

Studio-editable site settings:

```typescript
export type SiteSettings = Model<{
  id: UUID
  site_name: string
}, {
  singleton: true
  access: {
    read: Public
    update: Role<"admin">
  }
}>
```

## Storage buckets

```typescript
import type { Bucket, BucketPublic, BucketRole } from "@supatype/types"

export type marketingImages = Bucket<"marketing", {
  accessMode: "public"
  accept: ["image/jpeg", "image/png", "image/webp"]
  maxSize: "20MB"
  access: {
    read: BucketPublic
    create: BucketRole<"admin">
    delete: BucketRole<"admin">
  }
}>
```

## Common field types

`string`, `Int`, `SmallInt`, `UUID`, `Email`, `Timestamp`, `DateOnly`, `JSON`, `RichText`, `Blocks`, `ImageAsset`, `Optional<T>`, `Unique<T>`, `SupatypeAuthUserId`

Import from `@supatype/types`. Use `Optional<T>` for nullable fields.

## Schema change loop

```bash
supatype diff          # preview SQL / operations (no apply)
supatype push          # diff → confirm → migrate → generate types
supatype generate      # types only, no migration
```

After `push`, import updated types in app code. Never edit the generated output file.

## Adopting an existing database

`supatype pull` is removed in type-first mode. Instead:

1. Write models in `schema/index.ts` matching the existing tables
2. Run `supatype diff` to see drift
3. Use `supatype push` carefully: review destructive changes

For greenfield tables, define models first then push.
