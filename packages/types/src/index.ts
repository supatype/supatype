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
export type RichText = Primitive<"RichText", SerializedEditorState>

/** Visibility / S3 coupling for a storage bucket (`storage.buckets` + optional `PutBucketPolicy`). */
export type BucketAccessMode = "public" | "private" | "custom"

/**
 * Storage RLS subset: same primitives as {@link ModelMeta.access} (`read`, `create`, …) but typically
 * only `read` / `create` / `delete` are used for `storage.objects` policies when set on the bucket.
 */
export type BucketStorageAccess = {
  read?: Public | Private | LoggedIn | Owner<string> | Role<string>
  create?: Public | Private | LoggedIn | Owner<string> | Role<string>
  delete?: Public | Private | LoggedIn | Owner<string> | Role<string>
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
export type ImageAsset<TBucket extends Bucket = Bucket> = Primitive<"ImageAsset", Asset<TBucket> & {
  width?: number
  height?: number
}>
export type FileAsset<TBucket extends Bucket = Bucket> = Primitive<"FileAsset", Asset<TBucket>>

export type LocaleConfig<
  TLocales extends readonly string[] = readonly string[],
  TDefault extends TLocales[number] = TLocales[number],
> = Primitive<"LocaleConfig", { locales: TLocales; defaultLocale: TDefault }>
export type Block<
  TName extends string = string,
  TFields extends Record<string, unknown> = Record<string, unknown>,
  TMeta extends { label?: string; icon?: string } = {},
> = Primitive<`Block:${TName}`, { type: TName; meta?: TMeta } & TFields>
export type Blocks<TBlock extends Block = Block> = Primitive<"Blocks", TBlock[]>

export type Optional<T> = Modifier<"Optional", T | null>
export type Unique<T> = Modifier<"Unique", T>
export type Indexed<T> = Modifier<"Indexed", T>
export type Searchable<T> = Modifier<"Searchable", T>
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
}
export type HasMany<T, TOptions extends RelationOptions = {}> = Relation<"HasMany", T[]> & {
  readonly __relationOptions?: TOptions
}
export type HasOne<T, TOptions extends RelationOptions = {}> = Relation<"HasOne", T | null> & {
  readonly __relationOptions?: TOptions
}
export type ManyToMany<T, TOptions extends RelationOptions = {}> = Relation<"ManyToMany", T[]> & {
  readonly __relationOptions?: TOptions
}

export type Public = Access<"Public">
export type Private = Access<"Private">
export type LoggedIn = Access<"LoggedIn">
export type Owner<K extends string> = Access<"Owner", { readonly kind: "Owner"; readonly key: K }>
export type Role<R extends string = string> = Access<"Role", { readonly kind: "Role"; readonly role: R }>

export type ModelMeta = {
  access?: {
    read?: Public | Private | LoggedIn | Owner<string> | Role<string>
    create?: Public | Private | LoggedIn | Owner<string> | Role<string>
    update?: Public | Private | LoggedIn | Owner<string> | Role<string>
    delete?: Public | Private | LoggedIn | Owner<string> | Role<string>
  }
  tableName?: string
  searchable?: readonly string[]
}

export type Model<TFields extends Record<string, unknown>, TMeta extends ModelMeta = {}> = TFields & {
  readonly [SUPATYPE_MODEL]?: {
    readonly fields: TFields
    readonly meta: TMeta
  }
}
