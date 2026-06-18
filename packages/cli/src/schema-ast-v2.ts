/**
 * AST v2 wire format — canonical types and emitters.
 * Parsers build {@link ParsedField}; only `emitField` / `emitModel` / `emitSchema` produce JSON.
 */

export const AST_VERSION = 2 as const

export type DefaultAst =
  | { kind: "value"; value: string | number | boolean | null }
  | { kind: "now" }
  | { kind: "genRandomUuid" }
  | { kind: "expression"; expr: string }

export interface DbFieldAnnotations {
  pgType?: string
  unique?: boolean
  index?: boolean
  foreignKey?: string
  serverGenerated?: boolean
  elementType?: string
}

export interface PlatformFieldAnnotations {
  editor?: string
  readOnly?: boolean
}

export interface FieldAnnotations {
  db?: DbFieldAnnotations
  platform?: PlatformFieldAnnotations
}

/** Kernel facts only — never db/platform keys at this layer. */
export interface KernelFieldFacts {
  required?: boolean
  primaryKey?: boolean
  default?: DefaultAst
  localized?: boolean
  cardinality?: string
  target?: string
  values?: string[]
  from?: string
  sources?: string[]
  template?: string
  bucket?: string
  accessMode?: string
  geoType?: string
  srid?: number
  dimensions?: number
  blocks?: BlockDefinitionAst[]
  check?: string
  precision?: number
  scale?: number
  references?: string
  through?: string
  onDelete?: string
  onUpdate?: string
  uniqueFk?: boolean
  plugin?: string
  fieldType?: string
  tsType?: string
  index?: boolean
}

/** Internal parse result — not serialized. */
export interface ParsedField {
  kind: string
  kernel: KernelFieldFacts
  db: DbFieldAnnotations
  platform: PlatformFieldAnnotations
}

export type FieldAstV2 = {
  kind: string
  annotations?: FieldAnnotations
} & Record<string, unknown>

export interface BlockDefinitionAst {
  name: string
  label?: string
  icon?: string
  fields: Record<string, FieldAstV2>
}

export interface ModelAstV2 {
  name: string
  fields: Record<string, FieldAstV2>
  options: Record<string, unknown>
  annotations: {
    db: { tableName: string; indexes: unknown[] }
    platform: { access: Record<string, unknown> }
  }
}

export interface ExtractedStorageBucketAst {
  id: string
  public: boolean
  accessMode?: "public" | "private" | "custom"
  allowedMimeTypes?: string[]
  fileSizeLimit?: number
  access?: Record<string, unknown>
  s3BucketPolicy?: string
}

export interface ExtractedSchemaAstV2 {
  astVersion: typeof AST_VERSION
  models: ModelAstV2[]
  storageBuckets?: ExtractedStorageBucketAst[]
  locales?: string[]
  defaultLocale?: string
}

const DEFAULT_DB_BY_KIND: Record<string, Partial<DbFieldAnnotations>> = {
  text: { pgType: "TEXT" },
  richText: { pgType: "JSONB" },
  integer: { pgType: "INTEGER" },
  smallInt: { pgType: "SMALLINT" },
  bigInt: { pgType: "BIGINT" },
  float: { pgType: "DOUBLE PRECISION" },
  boolean: { pgType: "BOOLEAN" },
  datetime: { pgType: "TIMESTAMPTZ" },
  date: { pgType: "DATE" },
  timestamp: { pgType: "TIMESTAMP WITH TIME ZONE" },
  uuid: { pgType: "UUID" },
  email: { pgType: "TEXT" },
  url: { pgType: "TEXT" },
  slug: { pgType: "TEXT" },
  enum: { pgType: "TEXT" },
  json: { pgType: "JSONB" },
  decimal: { pgType: "TEXT" },
  bytes: { pgType: "BYTEA" },
  serial: { pgType: "SERIAL" },
  bigSerial: { pgType: "BIGSERIAL" },
  money: { pgType: "TEXT" },
  ip: { pgType: "TEXT" },
  cidr: { pgType: "TEXT" },
  macaddr: { pgType: "TEXT" },
  xml: { pgType: "TEXT" },
  tsQuery: { pgType: "TEXT" },
  tsVector: { pgType: "TEXT" },
  color: { pgType: "TEXT" },
  array: { pgType: "ARRAY" },
  image: { pgType: "JSONB" },
  file: { pgType: "JSONB" },
  geo: { pgType: "GEOGRAPHY" },
  vector: { pgType: "VECTOR" },
  blocks: { pgType: "JSONB" },
}

const DEFAULT_PLATFORM_BY_KIND: Record<string, Partial<PlatformFieldAnnotations>> = {
  richText: { editor: "rich" },
}

const COMPOSITE_KINDS = new Set(["timestamps", "publishable", "softDelete"])

function hasKeys(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).length > 0
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as Partial<T>
}

/** Start a parsed field with kind defaults for db/platform namespaces. */
export function defaultPgTypeForKind(kind: string): string {
  return DEFAULT_DB_BY_KIND[kind]?.pgType ?? "TEXT"
}

/** Flat wire shape for fields nested inside `blocks` definitions (engine FieldAst serde). */
export function emitBlockNestedField(field: FieldAstV2): FieldAstV2 {
  const annotations = (field.annotations ?? {}) as FieldAnnotations
  const db = annotations.db ?? {}
  const platform = annotations.platform ?? {}

  const wire: FieldAstV2 = {
    kind: field.kind,
    pgType: db.pgType ?? defaultPgTypeForKind(String(field.kind)),
    required: field.required ?? false,
    unique: db.unique ?? false,
    localized: field.localized ?? false,
  }

  if (platform.readOnly) wire.readOnly = true
  if (field.primaryKey) wire.primaryKey = true
  if (field.default !== undefined) wire.default = field.default
  if (field.from !== undefined) wire.from = field.from
  if (field.values !== undefined) wire.values = field.values
  if (field.bucket !== undefined) wire.bucket = field.bucket
  if (field.accessMode !== undefined) wire.accessMode = field.accessMode
  if (field.geoType !== undefined) wire.geoType = field.geoType
  if (field.srid !== undefined) wire.srid = field.srid
  if (field.dimensions !== undefined) wire.dimensions = field.dimensions
  if (field.check !== undefined) wire.check = field.check
  if (field.precision !== undefined) wire.precision = field.precision
  if (field.scale !== undefined) wire.scale = field.scale
  if (field.sources !== undefined) wire.sources = field.sources
  if (field.template !== undefined) wire.template = field.template
  if (field.plugin !== undefined) wire.plugin = field.plugin
  if (field.fieldType !== undefined) wire.fieldType = field.fieldType
  if (field.tsType !== undefined) wire.tsType = field.tsType

  return wire
}

export function scalar(
  kind: string,
  extra?: {
    kernel?: Partial<KernelFieldFacts>
    db?: Partial<DbFieldAnnotations>
    platform?: Partial<PlatformFieldAnnotations>
  },
): ParsedField {
  return {
    kind,
    kernel: { ...(extra?.kernel ?? {}) },
    db: { ...DEFAULT_DB_BY_KIND[kind], ...stripUndefined(extra?.db ?? {}) },
    platform: { ...DEFAULT_PLATFORM_BY_KIND[kind], ...stripUndefined(extra?.platform ?? {}) },
  }
}

export function emitField(parsed: ParsedField): FieldAstV2 {
  if (COMPOSITE_KINDS.has(parsed.kind)) {
    return { kind: parsed.kind }
  }

  const db = stripUndefined({
    ...DEFAULT_DB_BY_KIND[parsed.kind],
    ...parsed.db,
  }) as DbFieldAnnotations

  const platform = stripUndefined({
    ...DEFAULT_PLATFORM_BY_KIND[parsed.kind],
    ...parsed.platform,
  }) as PlatformFieldAnnotations

  const wire: FieldAstV2 = { kind: parsed.kind }

  const kernel = parsed.kernel
  if (kernel.required !== undefined) wire.required = kernel.required
  if (kernel.primaryKey) wire.primaryKey = true
  if (kernel.default !== undefined) wire.default = kernel.default
  if (kernel.localized) wire.localized = true
  if (kernel.cardinality !== undefined) wire.cardinality = kernel.cardinality
  if (kernel.target !== undefined) wire.target = kernel.target
  if (kernel.values !== undefined) wire.values = kernel.values
  if (kernel.from !== undefined) wire.from = kernel.from
  if (kernel.sources !== undefined && kernel.sources.length > 0) wire.sources = kernel.sources
  if (kernel.template !== undefined) wire.template = kernel.template
  if (kernel.bucket !== undefined) wire.bucket = kernel.bucket
  if (kernel.accessMode !== undefined) wire.accessMode = kernel.accessMode
  if (kernel.geoType !== undefined) wire.geoType = kernel.geoType
  if (kernel.srid !== undefined) wire.srid = kernel.srid
  if (kernel.dimensions !== undefined) wire.dimensions = kernel.dimensions
  if (kernel.blocks !== undefined) {
    wire.blocks = kernel.blocks.map((blockDef) => ({
      ...blockDef,
      fields: Object.fromEntries(
        Object.entries(blockDef.fields).map(([name, nested]) => [
          name,
          emitBlockNestedField(nested),
        ]),
      ),
    }))
  }
  if (kernel.check !== undefined) wire.check = kernel.check
  if (kernel.precision !== undefined) wire.precision = kernel.precision
  if (kernel.scale !== undefined) wire.scale = kernel.scale
  if (kernel.references !== undefined) wire.references = kernel.references
  if (kernel.through !== undefined) wire.through = kernel.through
  if (kernel.onDelete !== undefined) wire.onDelete = kernel.onDelete
  if (kernel.onUpdate !== undefined) wire.onUpdate = kernel.onUpdate
  if (kernel.uniqueFk) wire.uniqueFk = true
  if (kernel.plugin !== undefined) wire.plugin = kernel.plugin
  if (kernel.fieldType !== undefined) wire.fieldType = kernel.fieldType
  if (kernel.tsType !== undefined) wire.tsType = kernel.tsType
  if (parsed.kind === "blocks" && kernel.index !== undefined) wire.index = kernel.index

  const annotations: FieldAnnotations = {}
  if (hasKeys(db as Record<string, unknown>)) annotations.db = db
  if (hasKeys(platform as Record<string, unknown>)) annotations.platform = platform
  if (hasKeys(annotations as Record<string, unknown>)) wire.annotations = annotations

  return wire
}

export function emitModel(
  name: string,
  fields: Record<string, FieldAstV2>,
  options: Record<string, unknown>,
  tableName: string,
  access: Record<string, unknown>,
  indexes: unknown[] = [],
): ModelAstV2 {
  return {
    name,
    fields,
    options,
    annotations: {
      db: { tableName, indexes },
      platform: { access },
    },
  }
}

export function emitSchema(
  models: ModelAstV2[],
  extras?: {
    storageBuckets?: ExtractedSchemaAstV2["storageBuckets"]
    locales?: string[]
    defaultLocale?: string
  },
): ExtractedSchemaAstV2 {
  return {
    astVersion: AST_VERSION,
    models,
    ...(extras?.storageBuckets !== undefined &&
      extras.storageBuckets.length > 0 && { storageBuckets: extras.storageBuckets }),
    ...(extras?.locales !== undefined && extras.locales.length > 0 && { locales: extras.locales }),
    ...(extras?.defaultLocale !== undefined && { defaultLocale: extras.defaultLocale }),
  }
}
