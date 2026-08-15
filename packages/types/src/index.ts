import type { SerializedEditorState } from "./lexical.js"

declare const SUPATYPE_TYPE: unique symbol
declare const SUPATYPE_MODEL: unique symbol

/**
 * A value type wearing a compile-time label.
 *
 * Named for what it does rather than the community's "branded types" idiom, which reads as content
 * vocabulary in a package that also exports `Block`, `Blocks` and `Localized`.
 *
 * The phantom property is **optional**, which is what keeps values usable: `id.toUpperCase()` works and
 * a plain string can be assigned to a `UUID`. It also means the label is not reliably *detectable* — any
 * type structurally satisfies a tag whose only property is optional — so this is for things that are
 * values (`UUID`, an access rule, the model marker) and never for field declarations. Declarations use
 * a required discriminator instead; see `Modifier`.
 *
 * Two differently-tagged types do repel each other (`Email` is not a `UUID`), but only because
 * `exactOptionalPropertyTypes` is on. Erased at runtime: no value ever carries the property.
 */
type Tagged<TShape, TTag extends string> = TShape & {
  readonly [SUPATYPE_TYPE]?: { readonly tag: TTag }
}

type Primitive<TName extends string, TShape> = Tagged<TShape, `primitive:${TName}`>
/**
 * A field *declaration* wrapper — `Optional<string>`, `Unique<Slug>`, `Localized<RichText>`.
 *
 * **Nominal, with a required discriminator**, unlike `Tagged`. Nobody ever holds a value of type
 * `Optional<string>`: you declare a field with it and read the row shape `Model<>` derives, so this does
 * not need to be assignable to its own inner type — and making it so was the cause of three defects.
 *
 * As an intersection carrying an optional tag, every type satisfied `Modifier<Name, infer _>`: a plain
 * `string` reported as `Optional`, so unwrapping never reached a fixed point (`TS2589` on reading any
 * optional field), `Optional<FileAsset<B>>` collapsed to `never`, and stacked modifiers lost their tag
 * to an intersection so only structural matching could see the outer one. A required property is
 * exactly what the relation types already use (`__relationKind`), which is why relation detection was
 * never broken.
 */
type Modifier<TName extends string, TInner> = {
  readonly __modifier: TName
  readonly __inner: TInner
}
type Relation<TName extends string, TInner> = Tagged<TInner, `relation:${TName}`>
type Access<TName extends string, TShape = { readonly kind: TName }> = Tagged<TShape, `access:${TName}`>

export type UUID = Primitive<"UUID", string>
export type Email = Primitive<"Email", string>
export type URL = Primitive<"URL", string>
/**
 * URL-safe slug stored as text. Optional type argument names the source field used
 * for auto-generation (DB trigger + Studio). Defaults to `"title"`.
 */
export type Slug<TSource extends string = "title"> = Primitive<`Slug:${TSource}`, string>
export type PhoneNumber = Primitive<"PhoneNumber", string>
export type Markdown = Primitive<"Markdown", string>
export type Color = Primitive<"Color", string>
export type Int = Primitive<"Int", number>
export type SmallInt = Primitive<"SmallInt", number>
export type BigInt = Primitive<"BigInt", bigint>
export type Float = Primitive<"Float", number>
export type Decimal<P extends number, S extends number> = Primitive<`Decimal:${P}:${S}`, string>
export type Money = Primitive<"Money", string>
export type Vector<N extends number> = Primitive<`Vector:${N}`, number[]>
export type JSON<T> = Primitive<"JSON", T>
export type IPAddress = Primitive<"IPAddress", string>
export type CIDR = Primitive<"CIDR", string>
export type MacAddress = Primitive<"MacAddress", string>
export type Bytea = Primitive<"Bytea", string>
export type XML = Primitive<"XML", string>
export type TSQuery = Primitive<"TSQuery", string>
export type TSVector = Primitive<"TSVector", string>
export type DateOnly = Primitive<"DateOnly", Date>
export type DateTime = Primitive<"DateTime", Date>
export type Timestamp = Primitive<"Timestamp", Date>
export type Geo = Primitive<"Geo", { type: "point" | "polygon" | "linestring"; coordinates: unknown }>

/** Source text with the language it is written in. Stored as `JSONB`. */
export type Code<Lang extends string = string> = Primitive<"Code", { lang: Lang; source: string }>
export type Duration = Primitive<"Duration", { ms: number }>
export type GeoPoint = Primitive<"GeoPoint", { lat: number; lng: number }>
/**
 * An amount in minor units with the currency it is denominated in. Stored as `JSONB`.
 *
 * `amount` is a **string**, like {@link Money} and {@link Decimal}, because the value crosses the
 * wire as JSON: `bigint` cannot be serialised (`JSON.stringify(1n)` throws) and `number` loses
 * integers past 2^53. Use {@link Money} or {@link Decimal} instead when you want a numeric column
 * to sum and index — this type keeps the currency with the amount, which a scalar column cannot.
 */
export type Currency<Code extends string = string> = Primitive<"Currency", { amount: string; code: Code }>

/** Link target for {@link Button}. */
export type ButtonTarget = "_self" | "_blank"

/** CMS button / CTA — label, href, optional aria-label and target (stored as JSONB). */
export type ButtonValue = {
  label: string
  href: string
  ariaLabel?: string
  target?: ButtonTarget
}

export type Button = Primitive<"Button", ButtonValue>
/**
 * Lexical JSON in DB/UI.
 * **`string`** is allowed in TS for defaults, seeds, and incremental adoption (plain text or Lexical JSON string — not HTML).
 *
 * Schema defaults:
 * - `RichText<"Your sentence">` — plain-text default (sugar)
 * - `Default<RichText, "Your sentence">` — same, composes with modifiers
 * - Lexical document: pass a JSON string literal or use `Default<RichText, '{"root":…}'>`
 */
export type RichText<D extends string = never> = Primitive<
  D extends never ? "RichText" : `RichText:${D}`,
  SerializedEditorState | string
>

/** Visibility / S3 coupling for a storage bucket (`storage.buckets` + optional `PutBucketPolicy`). */
export type BucketAccessMode = "public" | "private" | "custom"
export type BucketPublic = Access<"BucketPublic">
export type BucketPrivate = Access<"BucketPrivate">
export type BucketLoggedIn = Access<"BucketLoggedIn">
export type BucketOwner = Access<"BucketOwner">
export type BucketRole<R extends string = string> = Access<"BucketRole", {
  readonly kind: "BucketRole"
  readonly role: R
}>

/**
 * Storage RLS subset: same primitives as {@link ModelMeta.access} (`read`, `create`, …) but typically
 * only `read` / `create` / `delete` are used for `storage.objects` policies when set on the bucket.
 */
export type BucketStorageAccess = {
  read?: BucketPublic | BucketPrivate | BucketLoggedIn | BucketOwner | BucketRole<string>
  create?: BucketPublic | BucketPrivate | BucketLoggedIn | BucketOwner | BucketRole<string>
  delete?: BucketPublic | BucketPrivate | BucketLoggedIn | BucketOwner | BucketRole<string>
}

/**
 * Second generic on {@link Bucket}. Parsed by `@supatype/cli` into `storage.buckets` rows and optional
 * bucket-scoped storage RLS. String sizes (`maxSize`) use CLI parsing (e.g. `"50MB"`).
 */
export type BucketConfig<
  _TAccess extends BucketAccessMode | undefined = undefined,
  _TMax extends string | undefined = undefined,
> = {
  accessMode?: BucketAccessMode
  maxSize?: string
  accept?: readonly string[]
  /** When set with `access`, drives `storage.objects` RLS for this bucket instead of model `access`. */
  access?: BucketStorageAccess
  /** Raw AWS S3 / MinIO bucket policy JSON string; when set, overrides the default policy for public/custom flows. */
  s3BucketPolicy?: string
}

/**
 * Names a logical storage bucket. Export `type AvatarBucket = Bucket<"avatars", { … }>` and pass
 * {@link ImageAsset}<AvatarBucket> / {@link FileAsset}<AvatarBucket> on models.
 *
 * Config is erased at runtime — only `@supatype/cli` reads it via the TypeScript type checker shape.
 */
export type Bucket<
  TName extends string = string,
  TConfig extends BucketConfig | Record<string, unknown> = BucketConfig,
> = Primitive<`Bucket:${TName}`, { name: TName; config?: TConfig }>
export type Asset<TBucket extends Bucket = Bucket> = Primitive<"Asset", {
  bucket: TBucket
  path: string
  mimeType?: string
  size?: number
}>
/** Second generic on {@link ImageAsset} / {@link FileAsset} — parsed by CLI only. */
export type AssetFieldOptions = {
  /** When true, stored as JSONB locale map of storage refs. Default false. */
  localized?: boolean
}

export type ImageAsset<
  TBucket extends Bucket = Bucket,
  TOptions extends AssetFieldOptions = {},
> = Primitive<"ImageAsset", Asset<TBucket> & {
  width?: number
  height?: number
  config?: TOptions
}>
export type FileAsset<
  TBucket extends Bucket = Bucket,
  TOptions extends AssetFieldOptions = {},
> = Primitive<"FileAsset", Asset<TBucket> & { config?: TOptions }>

export type LocaleConfig<
  TLocales extends readonly string[] = readonly string[],
  TDefault extends TLocales[number] = TLocales[number],
> = Primitive<"LocaleConfig", { locales: TLocales; defaultLocale: TDefault }>
/**
 * Translatable field — stored as JSONB with locale keys in Postgres,
 * e.g. `{ "en": "Hello", "de": "Hallo" }`. Configure locales with {@link LocaleConfig}.
 *
 * Use `Optional<Localized<string>>` when the field may be null.
 */
export type Localized<T> = Modifier<"Localized", Record<string, T>>
/** Opt out of {@link LocalizedModel} auto-localization for a copy-like field. */
export type NotLocalized<T> = Modifier<"NotLocalized", T>
export type Block<
  TName extends string = string,
  TFields extends Record<string, unknown> = Record<string, unknown>,
  TMeta extends { label?: string; icon?: string } = {},
> = Primitive<`Block:${TName}`, { type: TName; meta?: TMeta } & TFields>
export type Blocks<TBlock extends Block = Block> = Primitive<"Blocks", TBlock[]>

/**
 * Nullable column (`T | null` in Postgres). **`Model`** flattens this to an optional property
 * **`key?: T | null`** on the inferred row shape so literals and seeds omit `coverImage`-style keys
 * without casts.
 */
export type Optional<T> = Modifier<"Optional", T | null>
export type Unique<T> = Modifier<"Unique", T>
export type Indexed<T> = Modifier<"Indexed", T>
export type Searchable<T> = Modifier<"Searchable", T>
export type EditorReadOnly<T> = Modifier<"EditorReadOnly", T>
/**
 * DB / trigger maintained only: Studio treats as read-only + server-generated on insert.
 * There is **no** live preview or “follow title until edited” UX — declare dependencies with
 * {@link ComputedFrom} instead if you want slug-like preview in Studio.
 */
export type Computed<T> = Modifier<"Computed", T>
/**
 * Plain-text column with Studio preview built from `sources` until the author edits the field
 * on create (same UX as {@link Slug}). Database column is ordinary TEXT; optional overrides are persisted.
 *
 * Use `Optional<ComputedFrom<…>>` when the field may be null.
 *
 * **Second type argument — three shapes:**
 * - **One field** (concat preview): `ComputedFrom<string, "title">`
 * - **Several fields** (join with spaces, then truncate): `ComputedFrom<string, readonly ["title", "subtitle"]>`
 * - **Template string** (placeholders + optional `truncate`): a string literal containing `{fieldName}` and/or
 *   `{truncate(fieldName, maxChars)}`. Dependencies are inferred for validation and Studio.
 *
 * Template examples (single string literal type; use real `\n` in the string when you want a newline):
 * - `ComputedFrom<string, "Author: {authorProfile} | {created_at}">`
 * - `ComputedFrom<string, "{truncate(body, 100)}">`
 * - `ComputedFrom<string, "Author: {authorProfile} | Date: {created_at}\n{truncate(body, 100)}">`
 */
export type ComputedFrom<
  TValue,
  TSources extends string | readonly string[] = "title",
> = Modifier<"ComputedFrom", TValue>
export type PrimaryKey<T> = Modifier<"PrimaryKey", T>
export type AutoIncrement<T extends number | bigint> = Modifier<"AutoIncrement", T>
/**
 * Column value is assigned by the database (trigger, `DEFAULT`, sequence, etc.).
 * Inserts may omit this field; generated client `Insert` types mark it optional.
 */
export type ServerDefault<T> = Modifier<"ServerDefault", T>
export type Default<T, V> = Modifier<`Default:${Extract<V, string | number | boolean | bigint | null>}`, T>
export type MaxLength<T, N extends number> = Modifier<`MaxLength:${N}`, T>
export type MinLength<T, N extends number> = Modifier<`MinLength:${N}`, T>
export type Between<T, Min extends number, Max extends number> = Modifier<`Between:${Min}:${Max}`, T>
/**
 * Built-in audit pair: expands to columns with DB `DEFAULT NOW()` and Studio prefill on create.
 *
 * Equivalent manual fields: naming columns `created_at` / `updated_at` plus `Timestamp` / `ServerDefault<DateTime>`
 * wires the same defaults in the extractor; you don’t need this mixin unless you prefer the shorthand.
 *
 * Arbitrary timestamps use `ServerDefault<DateTime>` (or `@default`/`Expression` via engine fixtures) —
 * those are configurable; only the **names** above get the convention treatment without extra wrappers.
 */
export type Timestamps = {
  created_at: ServerDefault<Date>
  updated_at: ServerDefault<Date>
}
export type SoftDelete = {
  deleted_at: Optional<Date>
}
export type Publishable = {
  published_at: Optional<Date>
}
export type WithTimestamps<T extends Record<string, unknown>> = T & Timestamps
export type WithSoftDelete<T extends Record<string, unknown>> = T & SoftDelete
export type WithPublishable<T extends Record<string, unknown>> = T & Publishable

export type OnDelete = "cascade" | "setNull" | "restrict" | "noAction"
export type OnUpdate = OnDelete
/**
 * Options on a relation field.
 *
 * Only what the extractor reads. `inverse` used to be declared here and was honoured by nothing,
 * which is worse than absent: it type-checked, so a schema could name an inverse relation and get
 * silence. The inverse side is declared as its own `HasMany<…>` / `HasOne<…>` field instead.
 */
export type RelationOptions = {
  /** `NOT NULL` on the foreign key column. */
  required?: boolean
  onDelete?: OnDelete
  onUpdate?: OnUpdate
  /** `ManyToMany` only — the junction table's name, instead of one derived from the two models. */
  through?: string
}
/**
 * The target model, held behind a property so that resolving a relation field does not resolve the
 * model it points at.
 *
 * Two models that name each other — a `HasOne` and its `RelatedTo`, or a `RelatedTo` both ways —
 * used to fail with `TS2589: Type instantiation is excessively deep`. `Model<F>` spreads `F` through
 * a mapped type that probes every field (`[V] extends [Modifier<"Optional", …>]`), and probing
 * `RelatedTo<Post>` = `Post & …` meant expanding `Post`, which was still being defined. The
 * collection relations escaped it: `Comment[]` is decidable without expanding `Comment`, so
 * `HasMany` and `ManyToMany` are left as they were and only the one-ish relations defer here.
 *
 * Nothing needs a relation field's value type — the target's *identity* carries the relation, the
 * generated client types carry the row shapes, and the CLI reads these declarations as syntax
 * rather than resolving them. So the target moves into a phantom property, where TypeScript leaves
 * it alone until something asks.
 */
export interface RelationTarget<T> {
  readonly __relationTarget?: T
}
export type RelatedTo<T, TOptions extends RelationOptions = {}> = Relation<
  "RelatedTo",
  RelationTarget<T>
> & {
  readonly __relationOptions?: TOptions
  readonly __relationKind: "relatedTo"
}
// `HasMany` and `ManyToMany` keep the plain `T[]`: an array is already decidable without expanding
// its element, which is why the collection relations never hit the recursion in the first place.
export type HasMany<T, TOptions extends RelationOptions = {}> = Relation<"HasMany", T[]> & {
  readonly __relationOptions?: TOptions
  readonly __relationKind: "hasMany"
}
export type HasOne<T, TOptions extends RelationOptions = {}> = Relation<
  "HasOne",
  RelationTarget<T> | null
> & {
  readonly __relationOptions?: TOptions
  readonly __relationKind: "hasOne"
}
export type ManyToMany<T, TOptions extends RelationOptions = {}> = Relation<"ManyToMany", T[]> & {
  readonly __relationOptions?: TOptions
  readonly __relationKind: "manyToMany"
}

export type Public = Access<"Public">
export type Private = Access<"Private">
export type LoggedIn = Access<"LoggedIn">
export type SupatypeAuthUser = Primitive<"SupatypeAuthUser", { readonly system: "supatype:user" }>
export type SupatypeAuthUserId = Primitive<"SupatypeAuthUserId", string>
type ModelFieldKeys<TModel> =
  TModel extends { readonly [SUPATYPE_MODEL]?: { readonly fields: infer TFields } }
    ? Extract<keyof TFields, string>
    : never
type RelationFieldKeys<TFields extends Record<string, unknown>> = Extract<{
  [K in keyof TFields]-?: K extends string
    ? TFields[K] extends { readonly __relationKind: "relatedTo" }
      ? K
      : never
    : never
}[keyof TFields], string>
type RelationOwnerKeys<TFields extends Record<string, unknown>> = Extract<{
  [K in keyof TFields]-?: K extends string
    ? TFields[K] extends { readonly __relationKind: "relatedTo" }
      ? `${K}_id`
      : never
    : never
}[keyof TFields], string>
type SelfOwnerKey<TFields extends Record<string, unknown>> =
  "id" extends keyof TFields
    ? TFields["id"] extends SupatypeAuthUserId
      ? "id"
      : never
    : never
type OwnerEligibleFieldKeys<TFields extends Record<string, unknown>> =
  RelationOwnerKeys<TFields> | SelfOwnerKey<TFields>
type ModelRelationFieldKeys<TModel> =
  TModel extends { readonly [SUPATYPE_MODEL]?: { readonly fields: infer TFields } }
    ? TFields extends Record<string, unknown>
      ? OwnerEligibleFieldKeys<TFields>
      : never
    : never
type AnySupatypeModel = {
  readonly [SUPATYPE_MODEL]?: {
    readonly fields: Record<string, unknown>
    readonly meta: unknown
  }
}

/**
 * Ownership access rule.
 *
 * Backward-compatible form:
 *   Owner<"author_id">
 *
 * Typed model form (preferred, autocomplete + validation):
 *   Owner<Post, "author_id">
 */
export type Owner<
  TModelOrKey extends string | AnySupatypeModel,
  TKey extends TModelOrKey extends string ? string : ModelRelationFieldKeys<TModelOrKey> = TModelOrKey extends string
    ? TModelOrKey
    : never,
> = Access<"Owner", {
  readonly kind: "Owner"
  readonly key: TKey
  readonly __ownerModel?: TModelOrKey extends string ? never : TModelOrKey
}>
export type OwnerKey<TModel extends AnySupatypeModel> =
  ModelRelationFieldKeys<TModel>
export type OwnerOf<
  TModel extends AnySupatypeModel,
  TKey extends OwnerKey<TModel>,
> = Owner<TModel, TKey>
export type OwnerFrom<TRelationField extends string> = Access<"OwnerFrom", {
  readonly kind: "OwnerFrom"
  readonly relation: TRelationField
}>
export type Role<R extends string = string> = Access<"Role", { readonly kind: "Role"; readonly role: R }>

/**
 * OR-composition: access is granted when **any** listed rule matches.
 *
 * Without this, rules are a closed set of single shapes and the commonest real
 * requirement — "an admin, or the owner" — cannot be written at all. Every rule
 * is combinable, including nested `Any`.
 *
 * ```typescript
 * access: { update: Any<[Role<"admin">, Owner<"author_id">]> }
 * ```
 *
 * Compiles to the rules joined with `OR`. An empty list is rejected at extract
 * time rather than compiling to a policy that grants nothing.
 */
export type Any<TRules extends readonly unknown[]> = Access<"Any", {
  readonly kind: "Any"
  readonly rules: TRules
}>

/** AND-composition: access needs **every** listed rule to match. */
export type All<TRules extends readonly unknown[]> = Access<"All", {
  readonly kind: "All"
  readonly rules: TRules
}>

/** Negation. `Not<Role<"banned">>` grants access to everyone but that role. */
export type Not<TRule> = Access<"Not", { readonly kind: "Not"; readonly rule: TRule }>

// ─── Operands ────────────────────────────────────────────────────────────────
//
// The values a comparison can name. A bare string is a column on the model the
// rule is attached to; everything else is one of these.

/** The signed-in user's id. Compiles to `auth.uid()`, evaluated once per query. */
export type AuthUid = Access<"AuthUid", { readonly kind: "AuthUid" }>

/** The caller's role. Compiles to `auth.role()`, evaluated once per query. */
export type AuthRole = Access<"AuthRole", { readonly kind: "AuthRole" }>

/**
 * A nested JWT claim, by dotted path: `Claim<"app_metadata.tier">`.
 *
 * This is the developer's own namespace — whatever your application puts in its
 * tokens. A missing claim is SQL NULL, so comparing against one that is absent
 * denies rather than erroring.
 */
export type Claim<TPath extends string> = Access<"Claim", {
  readonly kind: "Claim"
  readonly path: TPath
}>

/** A constant. Bare strings in a comparison mean *columns*, so literals are explicit. */
export type Literal<TValue extends string | number | boolean> = Access<"Literal", {
  readonly kind: "Literal"
  readonly value: TValue
}>

// ─── Time ────────────────────────────────────────────────────────────────────
//
// A closed set of temporal operands. Closed on purpose: it keeps `now()` (which is
// STABLE, and evaluated once per query) as the only clock a rule can read.
// `clock_timestamp()` is VOLATILE and would make the generated affordance
// functions' STABLE declaration a lie.
//
// There is deliberately no literal-timestamp operand. "Publish at 09:00 next
// Tuesday" is *data* — the row carries `published_at`, and the rule is the same for
// every row: `Lte<"published_at", Now>`. The policy re-evaluates per query, so the
// row starts matching at 09:00 with no cron and no publish worker.

/** Transaction start time (`now()`). */
export type Now = Access<"Now", { readonly kind: "Now" }>

/** Units for {@link Ago} / {@link FromNow}. Plural only — Postgres accepts both. */
export type TimeUnit =
  | "seconds"
  | "minutes"
  | "hours"
  | "days"
  | "weeks"
  | "months"
  | "years"

/** Granularity for {@link StartOf}. */
export type TruncUnit = "day" | "week" | "month" | "year"

/**
 * The start of the current day, week, month or year — `date_trunc(unit, now())`.
 *
 * `Gte<"created_at", StartOf<"week">>` is "created since Monday".
 */
export type StartOf<TUnit extends TruncUnit> = Access<"StartOf", {
  readonly kind: "StartOf"
  readonly unit: TUnit
}>

/**
 * A duration before now: `Ago<30, "days">` is `now() - INTERVAL '30 days'`.
 *
 * Two arguments rather than one `"30 days"` string, for two reasons. A template
 * literal `` `${number} ${TimeUnit}` `` accepts `"-5 days"`, `"0.5 days"` and
 * `"1e3 days"` — the last is not valid interval syntax, so it type-checks and fails
 * at push. And TypeScript cannot enumerate `${number}`, so a template literal offers
 * **no autocomplete**; this form completes the unit properly.
 *
 * The amount must be a positive integer — for the other direction use
 * {@link FromNow}, which reads correctly rather than relying on a double negative.
 */
export type Ago<TAmount extends number, TUnit extends TimeUnit> = Access<"Ago", {
  readonly kind: "Ago"
  readonly amount: TAmount
  readonly unit: TUnit
}>

/** A duration after now: `FromNow<7, "days">` is `now() + INTERVAL '7 days'`. */
export type FromNow<TAmount extends number, TUnit extends TimeUnit> = Access<"FromNow", {
  readonly kind: "FromNow"
  readonly amount: TAmount
  readonly unit: TUnit
}>

// ─── Comparisons ─────────────────────────────────────────────────────────────

type Comparison<TName extends string, TLeft, TRight> = Access<TName, {
  readonly kind: TName
  readonly left: TLeft
  readonly right: TRight
}>

/**
 * `Eq<"author_id", AuthUid>` — the row's `author_id` equals the caller.
 *
 * A bare string on either side is a column name; use `Literal<…>` for a constant,
 * so `Eq<"status", Literal<"published">>` cannot be confused with a comparison
 * between two columns.
 */
export type Eq<TLeft, TRight> = Comparison<"Eq", TLeft, TRight>
export type Neq<TLeft, TRight> = Comparison<"Neq", TLeft, TRight>
export type Gt<TLeft, TRight> = Comparison<"Gt", TLeft, TRight>
export type Gte<TLeft, TRight> = Comparison<"Gte", TLeft, TRight>
export type Lt<TLeft, TRight> = Comparison<"Lt", TLeft, TRight>
export type Lte<TLeft, TRight> = Comparison<"Lte", TLeft, TRight>
export type Like<TLeft, TRight> = Comparison<"Like", TLeft, TRight>

/**
 * `IsNull<"deleted_at">` / `NotNull<"published_at">`.
 *
 * Separate from `Eq`, because SQL null comparison is not equality: `col = NULL`
 * is null, never true, so writing it that way would deny everything silently.
 */
export type IsNull<TOperand> = Access<"IsNull", { readonly kind: "IsNull"; readonly operand: TOperand }>
export type NotNull<TOperand> = Access<"NotNull", { readonly kind: "NotNull"; readonly operand: TOperand }>

// ─── Membership ──────────────────────────────────────────────────────────────

/**
 * Rows of another table, narrowed by a rule: the source for a membership test.
 *
 * ```typescript
 * type MySites = Rows<"user_sites", "site_id", Eq<"user_id", AuthUid>>
 * ```
 *
 * The `Where` rule is evaluated against `user_sites`, not against the model the
 * access rule is attached to — it is what makes this *the caller's* sites rather
 * than every row in the join table.
 *
 * Because the join column is named here, the engine emits the index for it. The
 * classic RLS performance trap is a membership subquery scanning an unindexed join
 * table once per row tested; naming it makes that generated infrastructure.
 */
export type Rows<
  TTable extends string,
  TColumn extends string,
  TWhere = never,
> = Access<"Rows", {
  readonly kind: "Rows"
  readonly table: TTable
  readonly column: TColumn
  readonly where: TWhere
}>

/** A fixed set, for `In<"status", Values<["draft", "review"]>>`. */
export type Values<TItems extends readonly (string | number | boolean)[]> = Access<"Values", {
  readonly kind: "Values"
  readonly values: TItems
}>

/**
 * `In<"site_id", MySites>` — the row's column appears in the source set.
 *
 * Compiles to a semi-join (`EXISTS`), not `IN (SELECT …)`, so the planner stops at
 * the first match per row instead of materialising the set. Sources are `Rows<>`,
 * `Claim<>` (a claim holding an array) or `Values<>`.
 */
export type In<TColumn extends string, TSource> = Access<"In", {
  readonly kind: "In"
  readonly column: TColumn
  readonly source: TSource
}>

/**
 * The source set is non-empty, independent of any column.
 *
 * `In<>` asks "is this row's value in the set", which is a different question.
 * Guarding on `Exists<>` is what makes "an editor *who has sites* may see their
 * sites or unassigned rows" mean what it says — without it, an editor with no sites
 * still matches the unassigned branch:
 *
 * ```typescript
 * type MySites = Rows<"user_sites", "site_id", Eq<"user_id", AuthUid>>
 * All<[Role<"editor">, Exists<MySites>, Any<[In<"site_id", MySites>, IsNull<"site_id">]>]>
 * ```
 */
export type Exists<TSource> = Access<"Exists", {
  readonly kind: "Exists"
  readonly source: TSource
}>
type BoundOwnerForFields<TFields extends Record<string, unknown>> = Access<"Owner", {
  readonly kind: "Owner"
  readonly key: OwnerEligibleFieldKeys<TFields>
  readonly __ownerModel?: Model<TFields, any>
}>
type BoundOwnerFromForFields<TFields extends Record<string, unknown>> = Access<"OwnerFrom", {
  readonly kind: "OwnerFrom"
  readonly relation: RelationFieldKeys<TFields>
}>

/**
 * The composable half of the DSL — every shape that takes other rules or operands
 * as arguments.
 *
 * Written with `unknown` arguments rather than a recursive constraint. TypeScript
 * cannot thread the model's field names down through a tuple of nested rules
 * without instantiation-depth failures on the deeper compositions, so a column
 * named inside a composition is checked by Postgres when the policy is created,
 * not by the editor. The named shapes below stay bound to the model's fields, so
 * the common `Owner<…>` typo is still caught where it always was.
 */
type ComposedAccessRule =
  | Any<readonly unknown[]>
  | All<readonly unknown[]>
  | Not<unknown>
  | Eq<unknown, unknown>
  | Neq<unknown, unknown>
  | Gt<unknown, unknown>
  | Gte<unknown, unknown>
  | Lt<unknown, unknown>
  | Lte<unknown, unknown>
  | Like<unknown, unknown>
  | IsNull<unknown>
  | NotNull<unknown>
  | In<string, unknown>
  | Exists<unknown>

/**
 * Any rule that may stand as an access predicate for a model.
 *
 * The named shapes stay bound to `TFields` so `Owner<"athor_id">` is still a typo
 * the editor catches; the composed shapes are open, per the note above.
 */
export type AccessRuleFor<TFields extends Record<string, unknown>> =
  | Public
  | Private
  | LoggedIn
  | Owner<OwnerEligibleFieldKeys<TFields>>
  | OwnerFrom<RelationFieldKeys<TFields>>
  | BoundOwnerForFields<TFields>
  | BoundOwnerFromForFields<TFields>
  | Role<string>
  | ComposedAccessRule

/**
 * `update` as a plain rule, or split into its two halves.
 *
 * `using` picks which existing rows may be modified, `check` constrains what they
 * may become. Unambiguous against a bare rule because every rule carries a `kind`
 * and this object does not.
 */
type UpdateAccessFor<TFields extends Record<string, unknown>> =
  | AccessRuleFor<TFields>
  | {
      readonly using: AccessRuleFor<TFields>
      readonly check?: AccessRuleFor<TFields>
    }

/**
 * Which modifier a declaration is, or `never` for anything that is not one.
 *
 * Reads the required discriminator, so a plain type answers `never` rather than claiming to be whatever
 * was asked. The bracketed comparison matters: `never` is assignable to everything, so a bare
 * `ModifierNameOf<V> extends TName` would report *true* for every unwrapped value.
 */
type ModifierNameOf<V> = V extends { readonly __modifier: infer TName extends string } ? TName : never
type ModifierInnerOf<V> = V extends { readonly __inner: infer TInner } ? TInner : never
type IsModifier<V, TName extends string> = [ModifierNameOf<V>] extends [TName] ? true : false

type IsModifierOptional<V> = IsModifier<V, "Optional">
type InferOptionalInner<V> = ModifierInnerOf<V>
type IsModifierLocalized<V> = IsModifier<V, "Localized">
type InferLocalizedInner<V> = ModifierInnerOf<V>
type IsModifierNotLocalized<V> = IsModifier<V, "NotLocalized">
type InferNotLocalizedInner<V> = ModifierInnerOf<V>

/**
 * Whether a field's key is optional on the row — `Optional` anywhere in the stack, not just outermost.
 *
 * `Unique<Optional<string>>` is as nullable as `Optional<Unique<string>>`. The old structural check
 * could only see the outer wrapper, so which one you wrote decided whether the key was optional.
 */
type HasOptionalModifier<V> = V extends {
  readonly __modifier: infer TName extends string
  readonly __inner: infer TInner
}
  ? TName extends "Optional"
    ? true
    : HasOptionalModifier<TInner>
  : false

type ImageAssetLocalizedOption<V> =
  V extends ImageAsset<infer _B, infer O> ? (O extends { localized: true } ? true : false) : false

type FileAssetLocalizedOption<V> =
  V extends FileAsset<infer _B, infer O> ? (O extends { localized: true } ? true : false) : false

/**
 * Apply default localization to copy-like fields (used by {@link LocalizedModel}).
 *
 * Walks *through* any modifier and rebuilds it around the localized inner, so `Unique<string>` becomes
 * `Unique<Localized<string>>`. It used to reach the `V extends string` branch for such a field — a
 * modifier was structurally its own inner type — and return a bare `Localized<string>`, silently
 * dropping the `Unique`.
 */
type ApplyAutoLocalizedField<V> =
  V extends { readonly __modifier: infer TName extends string; readonly __inner: infer TInner }
    ? TName extends "NotLocalized"
      ? TInner
      : TName extends "Localized"
        ? V
        : { readonly __modifier: TName; readonly __inner: ApplyAutoLocalizedField<TInner> }
    : V extends string
          ? Localized<string>
          : V extends RichText
            ? Localized<RichText>
            : V extends Markdown
              ? Localized<Markdown>
              : V extends Button
                ? Localized<Button>
                : ImageAssetLocalizedOption<V> extends true
                ? Localized<V>
                : FileAssetLocalizedOption<V> extends true
                  ? Localized<V>
                  : V

type ApplyAutoLocalizedFields<TFields extends Record<string, unknown>> = {
  [K in keyof TFields]: ApplyAutoLocalizedField<TFields[K]>
}

/**
 * The value a declared field reads as on the row: every modifier peeled off, whatever it is.
 *
 * Unbounded and still terminating, because each step removes one wrapper — `__inner` is strictly
 * smaller than the type it came from. The previous version needed a depth cap to escape a recursion
 * that could not converge, and a cap that runs out returns a half-unwrapped type rather than an error.
 *
 * Every modifier, not the three that used to be special-cased: a declaration is no longer structurally
 * its own inner type, so `Unique<Slug>` would otherwise surface on the row as the wrapper object rather
 * than as a string. `Localized<T>` needs no case of its own — its inner already *is* the locale record.
 */
type UnwrapModelFieldType<V> = V extends { readonly __modifier: string; readonly __inner: infer TInner }
  ? UnwrapModelFieldType<TInner>
  : V

/** Row shape from `TFields`: `Optional<…>` → `key?: Inner` (`Inner` includes `null`). */
export type SpreadOptionalModelFields<TFields extends Record<string, unknown>> =
  keyof TFields extends never
    ? {}
    : {
        [K in keyof TFields as HasOptionalModifier<TFields[K]> extends true ? never : K]: UnwrapModelFieldType<
          TFields[K]
        >
      } & {
        [K in keyof TFields as HasOptionalModifier<TFields[K]> extends true
          ? K extends keyof TFields & (string | number)
            ? K
            : never
          : never]?: UnwrapModelFieldType<TFields[K]>
      }

export type ModelIndex = {
  name?: string
  fields: readonly string[]
  unique?: true
}

export type ModelMeta<TFields extends Record<string, unknown>> = {
  access?: {
    read?: AccessRuleFor<TFields>
    create?: AccessRuleFor<TFields>
    update?: UpdateAccessFor<TFields>
    delete?: AccessRuleFor<TFields>
    /**
     * Per-column rules, narrowing the table rules for one field.
     *
     * ```typescript
     * access: {
     *   read: Public,
     *   fields: { salary: { read: Owner<"user_id">, write: Role<"admin"> } },
     * }
     * ```
     *
     * The **full rule language** applies, row-dependent rules included. A caller who
     * may not read the column gets `null` rather than a 403, because `SELECT *` names
     * every column and a revoked one would take the whole table down with it. Column
     * privileges are layered underneath for writes only, as defence in depth.
     *
     * Enforced one of two ways, chosen from what the database can do: the
     * `supatype_mask` extension rewrites every reference to the column in the planner,
     * and where the extension cannot be loaded — most managed Postgres — the same
     * expression is carried by generated views in an `api` schema instead.
     *
     * A `write` rule is compiled conjoined with the field's `read` rule, so write
     * without read is unrepresentable — otherwise a caller could round-trip away a
     * value they were never shown.
     *
     * **`INSERT` cannot evaluate a row-dependent write rule**: there is no row
     * yet, so the column falls back to its default instead of accepting the
     * submitted value. Use an identity-only rule (`Role<>`, `LoggedIn`,
     * `Claim<>`) for a column that must be settable at creation time.
     *
     * Relations are named by their column (`author_id`), because that is what the
     * restriction applies to — `author` is not a column at all.
     *
     * Neither tier half-enforces: a push never applies a schema whose restrictions do
     * not exist. They differ in one place — under the view tier an aggregate over a
     * masked column returns the sum of the rows the caller may read, where the
     * extension raises an error. Unreachable through the API, since PostgREST ships
     * with aggregates disabled.
     *
     * A column restricted from nearly everyone and queried often is still better off
     * in its own table — masking costs a predicate call per row and cannot use the
     * column's index.
     */
    fields?: {
      // Relations are named by their column (`author_id`), because that is what a
      // privilege is granted on — `author` is not a column at all.
      readonly [K in (keyof TFields & string) | RelationOwnerKeys<TFields>]?: {
        readonly read?: AccessRuleFor<TFields>
        readonly write?: AccessRuleFor<TFields>
      }
    }
  }
  tableName?: string
  searchable?: readonly string[]
  /** Composite or single-column indexes — emitted to Postgres via the schema engine. */
  indexes?: readonly ModelIndex[]
  /** Exactly one row — Studio Globals, singleton partial unique index in Postgres. */
  singleton?: true
  /** When omitted, the CLI infers from `WithTimestamps` or `created_at` / `updated_at` fields. */
  timestamps?: boolean
  /** When omitted, the CLI infers from `WithSoftDelete` or `deleted_at`. */
  softDelete?: boolean
  /** When true, copy-like fields default to localized (same as {@link LocalizedModel}). */
  autoLocalize?: true
  /**
   * Lifecycle hooks — an **edge function** run by the API at a write boundary.
   *
   * ```typescript
   * hooks: {
   *   beforeChange: "moderate-post",
   *   afterChange: { function: "index-post", timeout: 5000 },
   * }
   * ```
   *
   * The value names a function directory under your project's `functions/`, and the name is
   * checked when you push — a hook that silently never fires because of a typo is the failure
   * this feature must not have. `supatype push` also generates a typed handler signature per
   * hooked model, so `row` is the model's real column set rather than `unknown`.
   *
   * **A hook is not a security boundary.** It fires for writes through the API; direct SQL,
   * seeds, migrations and anything holding `service_role` bypass it. Invariants belong in
   * {@link ModelMeta.access}, a `CHECK`, or a generated column — all of which apply to every
   * writer. A hook is for the work that is genuinely application logic: enrichment,
   * notification, indexing, a validation the database cannot express.
   *
   * `beforeChange` and `beforeDelete` are called before the write reaches Postgres and can
   * reject it (any `4xx` from the function) or replace its body. `afterChange` and
   * `afterDelete` run once the write has succeeded and cannot change it.
   */
  hooks?: {
    readonly beforeChange?: ModelHook
    readonly afterChange?: ModelHook
    readonly beforeDelete?: ModelHook
    readonly afterDelete?: ModelHook
  }
}

/** A hook: a function name, or that name with per-hook options. */
export type ModelHook = string | ModelHookOptions

export type ModelHookOptions = {
  /** Function directory under the project's `functions/`. */
  readonly function: string
  /** Milliseconds before the hook is abandoned. Default 2000. */
  readonly timeout?: number
  /**
   * What it means when the hook **does not answer** — a timeout, a connection failure, a `5xx`,
   * or a body that cannot be parsed. A `4xx` is not this: that is the hook working correctly and
   * saying no, and it reaches the caller as the status the hook chose.
   *
   * Defaults to `"reject"` before a write (a validation hook that stopped running must not let
   * writes through) and `"log"` after one (the write already happened; there is nothing to fail).
   */
  readonly onUnavailable?: "reject" | "log"
}

/** Shorthand for singleton globals — `Model<Fields, GlobalMeta<Fields>>`. */
export type GlobalMeta<TFields extends Record<string, unknown>> = ModelMeta<TFields> & {
  singleton: true
}

export type LocalizedModelMeta<TFields extends Record<string, unknown>> = ModelMeta<
  ApplyAutoLocalizedFields<TFields>
> & {
  autoLocalize?: true
}

export type Model<TFields extends Record<string, unknown>, TMeta extends ModelMeta<TFields> = {}> =
  SpreadOptionalModelFields<TFields> & {
    readonly [SUPATYPE_MODEL]?: {
      readonly fields: TFields
      readonly meta: TMeta
    }
  }

/**
 * CMS-oriented model: plain `string` / `RichText` fields become localized automatically.
 * Use {@link NotLocalized} to opt out; {@link ImageAsset}<Bucket, { localized: true }> to opt in for images.
 */
export type LocalizedModel<
  TFields extends Record<string, unknown>,
  TMeta extends LocalizedModelMeta<TFields> = {},
> = Model<ApplyAutoLocalizedFields<TFields>, TMeta>
