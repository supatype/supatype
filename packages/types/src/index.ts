import type { SerializedEditorState } from "./lexical.js"

declare const SUPATYPE_TYPE: unique symbol
declare const SUPATYPE_MODEL: unique symbol

type Brand<TShape, TTag extends string> = TShape & {
  readonly [SUPATYPE_TYPE]?: { readonly tag: TTag }
}

type Primitive<TName extends string, TShape> = Brand<TShape, `primitive:${TName}`>
type Modifier<TName extends string, TInner> = Brand<TInner, `modifier:${TName}`>
type Relation<TName extends string, TInner> = Brand<TInner, `relation:${TName}`>
type Access<TName extends string, TShape = { readonly kind: TName }> = Brand<TShape, `access:${TName}`>

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

export type Code<Lang extends string = string> = Primitive<"Code", { lang: Lang; source: string }>
export type Duration = Primitive<"Duration", { ms: number }>
export type GeoPoint = Primitive<"GeoPoint", { lat: number; lng: number }>
export type Currency<Code extends string = string> = Primitive<"Currency", { amount: bigint; code: Code }>

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
export type RelationOptions = {
  required?: boolean
  onDelete?: OnDelete
  inverse?: string
}
export type RelatedTo<T, TOptions extends RelationOptions = {}> = Relation<"RelatedTo", T> & {
  readonly __relationOptions?: TOptions
  readonly __relationKind: "relatedTo"
}
export type HasMany<T, TOptions extends RelationOptions = {}> = Relation<"HasMany", T[]> & {
  readonly __relationOptions?: TOptions
  readonly __relationKind: "hasMany"
}
export type HasOne<T, TOptions extends RelationOptions = {}> = Relation<"HasOne", T | null> & {
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
type BoundOwnerForFields<TFields extends Record<string, unknown>> = Access<"Owner", {
  readonly kind: "Owner"
  readonly key: OwnerEligibleFieldKeys<TFields>
  readonly __ownerModel?: Model<TFields, any>
}>
type BoundOwnerFromForFields<TFields extends Record<string, unknown>> = Access<"OwnerFrom", {
  readonly kind: "OwnerFrom"
  readonly relation: RelationFieldKeys<TFields>
}>

/** `Optional<…>` wraps `Modifier<"Optional", …>` (detect structurally — do not inspect `[SUPATYPE_TYPE]`; primitives under `Optional` add their own tags and tag intersections are unreliable). */
type IsModifierOptional<V> = [V] extends [Modifier<"Optional", infer _>] ? true : false

type InferOptionalInner<V> = V extends Modifier<"Optional", infer Inner> ? Inner : never

type IsModifierLocalized<V> = [V] extends [Modifier<"Localized", infer _>] ? true : false

type InferLocalizedInner<V> = V extends Modifier<"Localized", infer Inner> ? Inner : never

type IsModifierNotLocalized<V> = [V] extends [Modifier<"NotLocalized", infer _>] ? true : false

type InferNotLocalizedInner<V> = V extends Modifier<"NotLocalized", infer Inner> ? Inner : never

type ImageAssetLocalizedOption<V> =
  V extends ImageAsset<infer _B, infer O> ? (O extends { localized: true } ? true : false) : false

type FileAssetLocalizedOption<V> =
  V extends FileAsset<infer _B, infer O> ? (O extends { localized: true } ? true : false) : false

/** Apply default localization to copy-like fields (used by {@link LocalizedModel}). */
type ApplyAutoLocalizedField<V> =
  IsModifierOptional<V> extends true
    ? Optional<ApplyAutoLocalizedField<InferOptionalInner<V>>>
    : IsModifierNotLocalized<V> extends true
      ? InferNotLocalizedInner<V>
      : IsModifierLocalized<V> extends true
        ? V
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

/** Strip `Optional` / `Localized` / `NotLocalized` wrappers for inferred row shapes. */
type UnwrapModelFieldType<V> =
  IsModifierOptional<V> extends true
    ? UnwrapModelFieldType<InferOptionalInner<V>>
    : IsModifierNotLocalized<V> extends true
      ? UnwrapModelFieldType<InferNotLocalizedInner<V>>
      : IsModifierLocalized<V> extends true
        ? InferLocalizedInner<V>
        : V

/** Row shape from `TFields`: `Optional<…>` → `key?: Inner` (`Inner` includes `null`). */
export type SpreadOptionalModelFields<TFields extends Record<string, unknown>> =
  keyof TFields extends never
    ? {}
    : {
        [K in keyof TFields as IsModifierOptional<TFields[K]> extends true ? never : K]: UnwrapModelFieldType<
          TFields[K]
        >
      } & {
        [K in keyof TFields as IsModifierOptional<TFields[K]> extends true
          ? K extends keyof TFields & (string | number)
            ? K
            : never
          : never]?: UnwrapModelFieldType<TFields[K]>
      }

export type ModelMeta<TFields extends Record<string, unknown>> = {
  access?: {
    read?:
      | Public
      | Private
      | LoggedIn
      | Owner<OwnerEligibleFieldKeys<TFields>>
      | OwnerFrom<RelationFieldKeys<TFields>>
      | BoundOwnerForFields<TFields>
      | BoundOwnerFromForFields<TFields>
      | Role<string>
    create?:
      | Public
      | Private
      | LoggedIn
      | Owner<OwnerEligibleFieldKeys<TFields>>
      | OwnerFrom<RelationFieldKeys<TFields>>
      | BoundOwnerForFields<TFields>
      | BoundOwnerFromForFields<TFields>
      | Role<string>
    update?:
      | Public
      | Private
      | LoggedIn
      | Owner<OwnerEligibleFieldKeys<TFields>>
      | OwnerFrom<RelationFieldKeys<TFields>>
      | BoundOwnerForFields<TFields>
      | BoundOwnerFromForFields<TFields>
      | Role<string>
    delete?:
      | Public
      | Private
      | LoggedIn
      | Owner<OwnerEligibleFieldKeys<TFields>>
      | OwnerFrom<RelationFieldKeys<TFields>>
      | BoundOwnerForFields<TFields>
      | BoundOwnerFromForFields<TFields>
      | Role<string>
  }
  tableName?: string
  searchable?: readonly string[]
  /** Exactly one row — Studio Globals, singleton partial unique index in Postgres. */
  singleton?: true
  /** When omitted, the CLI infers from `WithTimestamps` or `created_at` / `updated_at` fields. */
  timestamps?: boolean
  /** When omitted, the CLI infers from `WithSoftDelete` or `deleted_at`. */
  softDelete?: boolean
  /** When true, copy-like fields default to localized (same as {@link LocalizedModel}). */
  autoLocalize?: true
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
