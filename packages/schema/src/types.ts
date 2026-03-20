// ─── Core AST types (mirror parser/ast.rs) ──────────────────────────────────

export type DefaultValueDef =
  | { kind: "value"; value: unknown }
  | { kind: "expression"; expr: string }
  | { kind: "now" }
  | { kind: "genRandomUuid" }

export type RelationCardinality = "belongsTo" | "hasMany" | "hasOne" | "manyToMany"
export type IndexMethod = "btree" | "gin" | "gist" | "hnsw" | "brin"

export interface ScalarFieldMeta {
  kind: string
  pgType: string
  required: boolean
  primaryKey: boolean
  unique: boolean
  index: boolean
  localized?: boolean
  default?: DefaultValueDef
  check?: string
}

export interface SlugFieldMeta {
  kind: "slug"
  pgType: "TEXT"
  required: boolean
  unique: boolean
  from: string
}

export interface EnumFieldMeta {
  kind: "enum"
  pgType: "TEXT" | string
  values: readonly string[]
  required: boolean
  unique: boolean
  default?: string
  /**
   * When true, use a native Postgres enum type instead of TEXT + CHECK.
   * Native enums provide type safety at the database level but are harder
   * to modify (adding values is easy, removing/reordering requires type recreation).
   */
  nativeType?: boolean
  /** Name of the native Postgres enum type (auto-generated if not specified). */
  nativeTypeName?: string
}

export interface DecimalFieldMeta {
  kind: "decimal"
  pgType: string
  required: boolean
  precision?: number
  scale?: number
}

export interface JsonFieldMeta {
  kind: "json" | "jsonb" | "richText"
  pgType: "JSONB"
  required: boolean
  localized?: boolean
}

export type StorageAccessMode = "public" | "private" | "custom"

export interface StorageFieldMeta {
  kind: "image" | "file"
  pgType: "JSONB"
  required: boolean
  bucket: string
  maxSize?: number
  accept?: string[]
  accessMode?: StorageAccessMode
}

export interface GeoFieldMeta {
  kind: "geo"
  pgType: string
  required: boolean
  geoType: "point" | "polygon" | "linestring"
  srid?: number
}

export interface VectorFieldMeta {
  kind: "vector"
  pgType: string
  required: boolean
  dimensions: number
}

export interface ArrayFieldMeta {
  kind: "array"
  pgType: string
  elementType: string
  required: boolean
  default?: DefaultValueDef
}

export interface RelationMeta {
  kind: "relation"
  cardinality: RelationCardinality
  target: string
  foreignKey?: string
  references?: string
  through?: string
  onDelete?: string
  onUpdate?: string
}

export type CompositeKind = "timestamps" | "publishable" | "softDelete"

export interface IndexDef {
  name?: string
  fields: string[]
  unique: boolean
  using: IndexMethod
}

export type AccessRuleDef =
  | { type: "public" }
  | { type: "private" }
  | { type: "authenticated" }
  | { type: "owner"; field: string }
  | { type: "role"; roles: string[] }
  | { type: "custom"; expression: string }
  | { type: "any"; rules: AccessRuleDef[] }

export interface AccessDef {
  read?: AccessRuleDef
  create?: AccessRuleDef
  update?: AccessRuleDef
  delete?: AccessRuleDef
}

export interface ModelOptions {
  timestamps?: boolean
  softDelete?: boolean
  versioning?: boolean
}

export interface LocaleConfig {
  locales: string[]
  defaultLocale: string
  fallbackChains?: Record<string, string[]>
}

export interface BlockFieldMeta {
  kind: "blocks"
  pgType: "JSONB"
  required: boolean
  blockTypes: Array<{ name: string; icon?: string; label?: string; fields: Record<string, unknown> }>
  maxNestingDepth: number
}

// ─── Field phantom type ──────────────────────────────────────────────────────

/**
 * A field definition carrying both its TypeScript output type (as a phantom)
 * and its serialisation metadata.
 */
export interface Field<TOutput> {
  /** @internal Never set at runtime — phantom type only. */
  readonly __type: TOutput
  /** @internal Serialisation metadata read by the serialiser. */
  readonly __meta:
    | ScalarFieldMeta
    | SlugFieldMeta
    | EnumFieldMeta
    | DecimalFieldMeta
    | JsonFieldMeta
    | StorageFieldMeta
    | GeoFieldMeta
    | VectorFieldMeta
    | ArrayFieldMeta
    | BlockFieldMeta
    | { kind: CompositeKind }
}

/** A relation field. */
export interface Relation<TOutput> {
  readonly __type: TOutput
  readonly __meta: RelationMeta
}

// ─── Model definition ────────────────────────────────────────────────────────

export type AnyField = Field<unknown> | Relation<unknown>

export interface HookDef {
  timing: "beforeChange" | "afterChange" | "beforeRead" | "afterDelete"
  handler: string
}

export interface ModelMeta {
  name: string
  tableName: string
  fields: Record<string, AnyField>
  access: AccessDef
  indexes: IndexDef[]
  options: ModelOptions
  hooks?: HookDef[]
}

export interface ModelDefinition<TFields extends Record<string, AnyField>> {
  /** @internal */
  readonly __modelMeta: ModelMeta
  readonly fields: TFields
}

// ─── Schema AST (engine input) ───────────────────────────────────────────────

export interface FieldAst {
  kind: string
  [key: string]: unknown
}

export interface ModelAst {
  name: string
  tableName: string
  fields: Record<string, FieldAst>
  access: AccessDef
  indexes: IndexDef[]
  options: ModelOptions
  hooks?: HookDef[]
}

export interface SchemaAst {
  models: ModelAst[]
}

// ─── TypeScript inference helpers ────────────────────────────────────────────

/** Infer the runtime TypeScript type of a field. */
export type FieldType<F> = F extends Field<infer T> | Relation<infer T> ? T : never

/** Infer the Row type from a model's fields. */
export type ModelRow<TFields extends Record<string, AnyField>> = {
  [K in keyof TFields]: FieldType<TFields[K]>
}

/** Infer the Insert type (optional fields become optional; auto fields omitted). */
export type ModelInsert<TFields extends Record<string, AnyField>> = {
  [K in keyof TFields as TFields[K] extends Field<infer T>
    ? T extends null ? K : never
    : never
  ]?: FieldType<TFields[K]> extends null ? Exclude<FieldType<TFields[K]>, null> : FieldType<TFields[K]>
} & {
  [K in keyof TFields as TFields[K] extends Field<infer T>
    ? null extends T ? never : K
    : never
  ]: FieldType<TFields[K]>
}
