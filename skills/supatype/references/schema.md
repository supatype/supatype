# Schema reference

Schema is **type-first**: `schema/index.ts` is the source of truth. Define models with `@supatype/types`; the engine diffs against Postgres on `supatype push`.

Do **not** use legacy `@supatype/schema` builder API. Do **not** hand-edit generated type files.

## Basic model

```typescript
import type {
  Model, LoggedIn, Owner, Public, Role,
  SupatypeAuthUserId, UUID,
} from "@supatype/types"

/** App profile: `id` matches the Supatype auth user id. */
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
| `Owner<"field">` | Row owner via `"id"`, a `UUID` or `SupatypeAuthUserId` field, or a relation's key (`"author_id"`) |
| `OwnerFrom<"relation">` | Owner via related model |
| `Role<"admin">` | Users with named role |

Define `access` per operation: `read`, `create`, `update`, `delete`.

Owner rules are checked when the schema is read. The owner must be `"id"`, a relation whose key is on this model, or a `UUID` / `SupatypeAuthUserId` field. Owning through a relation is followed one relation deep, and the related model must be a user model (keyed by `SupatypeAuthUserId`) or have an Owner rule of its own; anything else is an error. A plain `UUID` owner works but warns: declare it `SupatypeAuthUserId` if it holds an auth user id.

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

`RelatedTo<T, { onDelete: "cascade"; onUpdate: "restrict" }>`: both take `"cascade"`, `"setNull"`,
`"restrict"` or `"noAction"` and become the foreign key's `ON DELETE` / `ON UPDATE`. `onDelete`
defaults to `"restrict"`, `onUpdate` to `"cascade"`. (`onUpdate` was ignored before 0.7.0; every key
was `ON UPDATE CASCADE`, which is still the default, so leaving it out changes nothing.)

## Field rules on INSERT

`access.fields.<column>.write` (or `read`, when there is no `write`) is judged on INSERT against the
row being stored, defaults included, like RLS `WITH CHECK`, so `Owner<"user_id">` works on create.
Leaving the field out, sending `null`, `DEFAULT`, or a value equal to the column default is not a
write: the default is stored and the rule is not judged. Any other value the rule refuses fails the
whole insert with `42501` (tier 1: `column "<table>"."<col>" cannot be written by this role`;
tier 2: `permission denied for column <col> of relation <table>`). `service_role` is exempt. UPDATE
is unchanged (cannot read: stored value kept silently; can read but not write: `42501`). Before
0.7.0 such a value was silently replaced by the default, so a create form that sends a field the
caller may not set must now leave it out.

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

## Studio labels

Studio names a model from its type, split into words and inflected: `ChildEducationExperiences` is
"Child Education Experience" for one record and "Child Education Experiences" for the list. A type
named in either number works. Override it where the guess reads wrong:

```typescript
export type PlacesOfInterest = Model<{
  id: UUID
  name: string
}, {
  label: "Place of Interest"
  labelPlural: "Places of Interest"
  access: { read: Public }
}>
```

`labelPlural` is inflected from `label` when omitted. Labels are presentation only and never cause a
migration.

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
    update: BucketRole<"admin">
    delete: BucketRole<"admin">
  }
}>
```

A bucket has the same four rules as a model: `read`, `create`, `update` (overwriting an existing
file) and `delete`. **A rule left out is refused** for every caller except the service role, and
`supatype push` warns about each one. A bucket with no `access` at all accepts no uploads.
`accessMode: "public"` still serves files on the public URL whatever `read` says.

Rules are enforced by Postgres: the storage service runs every upload, overwrite, delete and list as
the caller, against the policies the engine generates. Available rules: `BucketPublic`,
`BucketLoggedIn`, `BucketOwner` (the uploader), `BucketRole<"name">`, `BucketPrivate`. Any other key
in `access` is an error.

## Common field types

`string`, `Int`, `SmallInt`, `UUID`, `Email`, `Timestamp`, `DateOnly`, `JSON`, `RichText`, `Blocks`, `ImageAsset`, `Optional<T>`, `Unique<T>`, `SupatypeAuthUserId`

Import from `@supatype/types`. Use `Optional<T>` for nullable fields.

## Blocks

`Blocks<T>` is a JSONB array of sections an editor arranges in Studio, from the closed set of
`Block<"name", { ...fields }, { label?, icon? }>` types in `T`. Name a union with an alias when
several fields share it:

```typescript
export type HeroBlock = Block<"hero", { heading: Localized<string>; cta: Optional<Button> }>
export type ProseBlock = Block<"prose", { body: Localized<RichText> }>
export type PageBlock = HeroBlock | ProseBlock

export type Page = Model<{ id: UUID; body: Blocks<PageBlock> }>
```

Each entry is stored as `{ "type": "hero", "data": { "heading": { "en": "Hi" } } }`: the block's
name under `type`, its fields under `data`, read the way the same fields read on a model (a
`Localized` field is the locale map). Seeds and code that write blocks must use that shape, and a
renderer switches on `entry.type` and reads `entry.data`. Fields inside a block are not columns, so
no trigger normalises them: write rich text as Lexical state, not a plain string.

Rows stored before 0.7.0 may hold the old flat shape, `{ "type": "hero", "heading": "Hi" }`.
Moving the fields under `data` is not enough: a `Localized` field must become a locale map in the
project's `defaultLocale` (`{ "en": "Hi" }`), and a `RichText` field must become Lexical state (a
plain string as one paragraph, `{ "root": { "type": "root", "children": [{ "type": "paragraph",
... }] } }`); a `Localized<RichText>` field is both. `meta` stays beside `type`. On a model with
`versions`, every row of `<table>_versions` holds a copy in `data` and needs the same move, with the
snapshot table's triggers off for that `UPDATE` (its guard trigger silently keeps `data` as it
was). Run the migration as the database superuser before anyone saves those records in Studio,
which shows a flat entry's fields empty. The tested SQL is in the repo's `UPGRADING.md`, "Moving
rows saved in the old shape".

## Indexes, PostGIS and pgvector

`Indexed<T>` is a single-field B-tree. Anything else goes in the model's `indexes`:

```typescript
import type { GeoPoint, Model, UUID, Vector } from "@supatype/types"

export type Place = Model<{
  id: UUID
  location: GeoPoint
  embedding: Vector<1536>
}, {
  tableName: "places"
  indexes: [
    { fields: ["location"]; using: "gist" },
    { fields: ["embedding"]; using: "hnsw"; distance: "cosine" },
  ]
}>
```

- `using`: `"btree"` (default), `"gin"`, `"gist"` (for `Geo` / `GeoPoint`), `"hnsw"` (for `Vector`), `"brin"`.
- `distance` (hnsw only): `"cosine"` (default, `vector_cosine_ops`), `"l2"`, `"innerProduct"`. A query
  ordered by another distance does not use the index. `distance` on a non-hnsw index, or hnsw on a
  non-Vector field, is refused.

Extensions (`postgis`, `vector`, `unaccent`, `pgcrypto`) are created in the `extensions` schema on
every tier, not `public`. Columns still read, write and filter through REST and GraphQL, but the
extensions' own functions are **not** API endpoints (`/rest/v1/rpc/st_distance` is 404). To expose
one, write your own SQL function in `public` with `SET search_path = public, extensions`, leave it
`SECURITY INVOKER`, run `NOTIFY pgrst, 'reload schema'`, and call it with `supatype.rpc(...)`; the
push leaves functions it did not make alone. On an upgraded project the first push moves `vector`,
`unaccent` and `pgcrypto` out of `public` (a cautious change, asked for; `--yes` agrees). PostGIS
cannot be moved by a push: it stays in `public` with a warning on every push, and moving it is the
manual reload in UPGRADING.md, "Extensions move to the extensions schema" (docs:
`/docs/schema/fields#where-the-extensions-live`). Hand-written SQL must not prefix their objects with
`public.`.

A push that has to drop and re-add a column (a type it cannot convert, a column becoming generated,
a generated expression changing) puts back every index, constraint, foreign key (both directions),
trigger (with its enabled state) and policy on it from the catalog definition. A view on the column,
or a dependent in another schema, makes the push refuse before changing anything; drop it, push,
then recreate it.

## Identity and generated columns

The database fills these, so an insert leaves them out. A generated column is declared with
`Generated<T, "<sql>">`, the one supported form for every type. An identity column is
`Identity<T>` (or the `identity` option on `Int`, `SmallInt` and `BigInt`), and `AutoIncrement<T>`
is a key the database numbers.

```typescript
import type { Model, Int, SmallInt, Float, TSVector, Identity, AutoIncrement, Generated, PrimaryKey, Optional } from "@supatype/types"

export type Order = Model<{
  id: PrimaryKey<AutoIncrement<number>>             // = Identity<number, "by-default">
  ref: Identity<bigint>                             // = BigInt<{ identity: "always" }>
  line: SmallInt<{ identity: "always" }>            // a SMALLINT identity: options form
  price: Float
  qty: Int
  total: Generated<Float, "price * qty">
  note: Optional<string>
  note_lower: Optional<Generated<string, "lower(note)">>
  search: Optional<Generated<TSVector, "to_tsvector('english', coalesce(note, ''))">>
}>
```

- `Identity<T, "always" | "by-default">` (default `"always"`), or `identity` on `Int`, `SmallInt`,
  `BigInt`: `GENERATED ALWAYS AS IDENTITY` (an insert cannot give a value) or `GENERATED BY DEFAULT
  AS IDENTITY` (it may). Always NOT NULL.
- `AutoIncrement<T>` is `Identity<T, "by-default">`. It compiled to `SERIAL` before, and a serial
  column made then satisfies it: every push leaves it exactly as it is (no change, no warning). A new
  `AutoIncrement` column is an identity column generated by default. An explicit `Identity<...>` on a
  serial column converts it (its default and sequence dropped, the identity numbered on from its
  rows).
- `Generated<T, "<sql>">` on any scalar type (text, number, date and time, uuid, bytes, network and
  text-search types): `GENERATED ALWAYS AS (<sql>) STORED`, the SQL written over the row's column
  names (not another generated column's, which Postgres refuses). Not on `JSON`, `Decimal`, enums,
  arrays, relations, storage or localized fields. There is no options form to learn per type
  (`Text<{ generated }>` does not exist); use the alias.
- Neither takes a `Default<>`. In the generated client types an identity `always` column and a
  generated one are `?: never` on `Insert` and `Update`; an identity `by-default` column (and so
  `AutoIncrement`) is optional on insert.
- Needs an engine that reads them (it lists `identity_columns` in its capabilities). Against one that
  does not, `push`, `diff` and `dev` refuse the schema, naming the fields: update the engine, or
  declare them as plain columns and make the change in the database yourself. `adopt` and `pull`
  declare a live identity column as `Identity<...>`, a generated one as `Generated<...>` and a serial
  as `AutoIncrement<...>` only for such an engine.
- Changes push like any other: a plain integer becomes an identity (numbered on from its rows),
  `always` and `by-default` switch, an expression changes (in place on Postgres 17; the column is
  made again on 16, its values being derived). Taking an identity away, or a generation expression
  (the column keeps its values), is destructive like a drop: the push asks first (`--yes` in CI), and
  the engine refuses it without `--force`. So does a plain column becoming generated, which replaces
  its values.

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

**`RichText` holds a Lexical document and accepts a plain string.** A trigger normalises a
string into a single-paragraph document on insert and update, so the generated types read
`RichText` and write `RichText | string`: prose can be written as prose, and a read always
returns the document.
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

Supatype records every object it creates in its own ledger (`_supatype.managed_objects`, out of the API's reach). Comments stay yours. For a database Supatype did not create:

1. **Scaffold** (optional): `supatype introspect` or `supatype pull --dry-run` to draft `schema/index.ts`
2. **Align**: edit models until `supatype diff` shows only expected changes
3. **Adopt**: `supatype adopt` hands Supatype the objects a push refuses because the schema needs their names (writes ledger records only, no DDL)
4. **Push**: `supatype push` then brings adopted objects to the schema's definition and manages them from then on

An object that already matches what the schema would create is taken over without asking. An undeclared object is never taken.

### What doctor and push see

| State | Meaning | Push behavior |
|------|---------|---------------|
| **Missing** | Declared, or Supatype's and dropped by hand | Creates it |
| **Drifted** | Supatype's, changed outside Supatype | Puts it back; asks first for access rules (policies, grants, labels, RLS), and refuses without a terminal unless `--overwrite-drift` |
| **Stale** | Supatype's, no longer declared | Drops it (tables and columns need `--force`) |
| **Conflicting** | Declared name held by an object Supatype did not create | Refuses until `supatype adopt`, or a rename |
| **Unmanaged** | Not Supatype's (including columns you add to a model table) | Never touched |
| **Released** | Taken back with `supatype adopt --release` | Never touched, whatever the schema says, until `supatype adopt --reclaim` hands it back |
| **Out of scope** | `auth.*`, `_supatype.*`, extension tables | Ignored |

### Commands

```bash
supatype introspect          # JSON or table summary from live DB
supatype pull --dry-run      # draft Model<> scaffold (stdout)
supatype doctor              # what a push would find, by state
supatype doctor --strict     # CI: fail when a push would change or refuse something
supatype doctor --rebaseline # accept drifted objects as they are now (e.g. after a Postgres upgrade)
supatype doctor --rebaseline --accept-access-drift --yes   # also hand-edited policies/grants, without asking
supatype adopt               # preview; adopt --yes to take them
supatype adopt --release index:posts.posts_title_idx   # keep a hand-edited object as it is
supatype adopt --reclaim index:posts.posts_title_idx   # hand it back: the next push makes it match the schema
supatype diff                # preview operations
supatype push                # apply migration
```

`supatype pull` produces a **starting point**: types still flow from schema → `supatype generate`, not from the DB directly.

Removing `Unique<>` from a field drops its constraint only when Supatype created or adopted it. A unique constraint you added yourself stays, and `supatype doctor` lists it as unmanaged.

For greenfield tables, define models first then push; everything a push creates is recorded as Supatype's automatically.
