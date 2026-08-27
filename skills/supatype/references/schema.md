# Schema reference

Schema is **type-first**: `schema/index.ts` is the source of truth. Define models with `@supatype/types`; the engine diffs against Postgres on `supatype push`.

Do **not** use legacy `@supatype/schema` builder API. Do **not** hand-edit generated type files.

## Basic model

```typescript
import type {
  Model, LoggedIn, Owner, Public, Role,
  SupatypeAuthUserId, UUID,
} from "@supatype/types"

/** App profile — `id` matches the Supatype auth user id. */
export type Profile = Model<{
  id: SupatypeAuthUserId
  display_name: string
}, {
  access: {
    read: LoggedIn
    create: Owner<"id">
    update: Owner<"id">
    delete: Owner<"id">
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

## Field validation

Bounds are declared on the field's type. Each compiles to a Postgres `CHECK` on that column and is
also sent to Studio, which enforces the same rule in the edit form before the write is sent.

```ts
import type {
  Between, Blocks, DateOnly, Int, JSON, MaxItems, MaxLength, MinItems, MinLength, Optional, RichText,
} from "@supatype/types"

export type Event = Model<{
  id: UUID
  headline: MaxLength<string, 120>
  summary: MinLength<MaxLength<string, 4000>, 20>
  body: MaxLength<RichText, 2000>
  tags: MaxItems<string[], 10>
  sections: MinItems<Blocks<Section>, 1>
  setupItems: MinItems<JSON<SetupItem[]>, 1>
  rating: Between<Int, 1, 5>
  eventDay: Between<DateOnly, "2026-01-01", "2026-12-31">
  note: Optional<string>
}, { access: { read: Public } }>
```

| Modifier | Counts | Applies to |
|---|---|---|
| `MaxLength<T, N>`, `MinLength<T, N>` | characters, or octets for `Bytea` | text-like, rich text, bytes |
| `MaxItems<T, N>`, `MinItems<T, N>` | elements | arrays, `JSON<T[]>`, `Blocks` |
| `Between<T, Min, Max>` | value, inclusive | numerics, dates, times, intervals |

What each bound compiles to, by storage:

| Field | Bound | Enforced as |
|---|---|---|
| `string`, `Email`, `URL`, `Slug`, `Color`, `XML`, `IPAddress`, `CIDR`, `MacAddress` | length | `char_length(col)` |
| `RichText` | length | `char_length(_supatype.richtext_text(col))`, the plain text a reader sees |
| `Bytea` | length | `octet_length(col)` |
| `string[]` and other arrays | items | `cardinality(col)` |
| `JSON<T[]>`, `Blocks` | items | `jsonb_array_length(col)`, guarded by `jsonb_typeof` |
| `Int`, `SmallInt`, `BigInt`, `Float`, `Decimal`, `Money` | range | direct comparison, no cast |
| `DateTime`, `DateOnly`, `Timestamp` | range | compared as the column's own type |
| `Duration` intervals | range | `'30 days'::interval` |

A localized field is stored as JSONB keyed by locale, and every bound above has a per-locale form, so
a translation that runs long is rejected the same way a monolingual field would be. Studio names the
locale that breached.

Length and items are separate on purpose: length is always "how much text", items always "how many",
so you never need to know a column's storage to know what the number counts. Declaring the wrong one
is a push-time error naming the other.

`Between` takes numbers for a numeric column and ISO-8601 strings for a date or time column, and
compiles to that column's own type. A string bound on a number, a number bound on a date, or a
literal that is not a valid date all fail the push rather than failing mid-migration.

Rich text is measured by its plain text, through a managed helper function the engine creates.

Bounds stack and merge into one constraint. `Optional<T>` still allows NULL: a `CHECK` against NULL
passes, so an empty optional field is absent rather than too short.

**A bound is never silently ignored.** A modifier a field kind cannot honour fails the push and names
the alternative, so `MaxLength` on an array tells you to use `MaxItems`, and a bound on an image
points you at the bucket's `fileSizeLimit`.

For a rule the type system cannot express, use a model `beforeChange` hook and return `{ reject }`:

```ts
const validateProduct: BeforeChange<"products"> = async (ctx) => {
  for (const row of ctx.rows) {
    if (!Array.isArray(row.setup_items) || row.setup_items.length === 0) {
      return { reject: "At least one setup item is required." }
    }
  }
  return { rows: ctx.rows }
}
export default hook(validateProduct)
```

For a rule about one field, declare a validator instead. Its refusal names that field, so a form can
put the message on the input rather than in a banner:

```ts
export type Product = Model<{
  id: UUID
  setupItems: JSON<SetupItem[]>
}, {
  access: { read: Public }
  validate: { setupItems: "validate-setup-items" }
}>
```

```ts
// hooks/validate-setup-items/index.ts
import { fieldValidator, type FieldValidator } from "../_supatype/hooks.ts"

const check: FieldValidator<"product", "setupItems"> = (ctx) => {
  if (!Array.isArray(ctx.value) || ctx.value.length === 0) {
    return "At least one setup item is required."
  }
  return true
}

export default fieldValidator(check)
```

`ctx.value` is that column's real type. Return `true` to accept or a message to refuse.

A validator runs on the API write path, so direct SQL, seeds and migrations are not subject to it.
Anything expressible as a bound or a `constraints` rule should be one, because those hold for every
writer. A validator whose function is missing fails the push, and one that cannot be reached refuses
the write: a value nobody checked is not a value that passed.

## Schema change loop

```bash
supatype diff          # preview SQL / operations (no apply)
supatype push          # diff → confirm → migrate → generate types
supatype generate      # types only, no migration
```

After `push`, import updated types in app code. Never edit the generated output file.

## Adopting an existing database

For databases created before Supatype managed-object stamping:

1. **Scaffold** (optional): `supatype introspect` or `supatype pull --dry-run` to draft `schema/index.ts`
2. **Align**: edit models until `supatype diff` shows only expected changes
3. **Adopt**: `supatype adopt` stamps `supatype:managed` comments on matching constraints/indexes (no DDL)
4. **Push**: `supatype push` can then create/drop stamped objects safely

### Managed object tiers

| Tier | Meaning | Push behavior |
|------|---------|---------------|
| **Expected** | Declared in `schema/index.ts` | Create or drop (with validation) |
| **Managed-stale** | Stamped, not in AST | Drop only after doctor review |
| **Unmanaged** | In DB, no stamp, not in AST | Never auto-dropped |
| **Out of scope** | `auth.*`, `_supatype.*`, extension tables | Ignored |

### Commands

```bash
supatype introspect          # JSON or table summary from live DB
supatype pull --dry-run      # draft Model<> scaffold (stdout)
supatype doctor              # missing / stale / unmanaged drift report
supatype doctor --strict     # CI: fail on missing or stale managed
supatype adopt               # preview stamps; adopt --yes to apply
supatype diff                # preview operations
supatype push                # apply migration
```

`supatype pull` produces a **starting point** — types still flow from schema → `supatype generate`, not from the DB directly.

Removing a column `Unique<>` emits `DropUniqueConstraint` only when the constraint has a `supatype:managed` comment (or was created by Supatype). Pre-existing constraints without stamps are reported by `supatype doctor` as unmanaged drift.

For greenfield tables, define models first then push — all created constraints and indexes are stamped automatically.
