import type {
  DefaultValueDef,
  DecimalFieldMeta,
  EnumFieldMeta,
  Field,
  GeoFieldMeta,
  JsonFieldMeta,
  ScalarFieldMeta,
  SlugFieldMeta,
  StorageFieldMeta,
  VectorFieldMeta,
} from "./types.js"

// ─── Field option types ───────────────────────────────────────────────────────

interface BaseOpts {
  required?: boolean
  default?: DefaultValueDef
  unique?: boolean
  index?: boolean
}

interface TextOpts extends BaseOpts {
  maxLength?: number
}

interface NumberOpts extends BaseOpts {
  min?: number
  max?: number
}

interface DecimalOpts {
  required?: boolean
  precision?: number
  scale?: number
}

interface EnumOpts {
  required?: boolean
  default?: string
  unique?: boolean
}

interface SlugOpts {
  from: string
  unique?: boolean
  required?: boolean
}

interface JsonOpts {
  required?: boolean
}

interface StorageOpts {
  required?: boolean
  bucket?: string
  maxSize?: number
  allowedFormats?: string[]
}

interface GeoOpts {
  required?: boolean
  type?: "point" | "polygon" | "linestring"
  srid?: number
}

interface VectorOpts {
  dimensions: number
  required?: boolean
}

// ─── Internal builder ─────────────────────────────────────────────────────────

function makeField<TOutput>(meta: Field<TOutput>["__meta"]): Field<TOutput> {
  return { __type: undefined as TOutput, __meta: meta } as Field<TOutput>
}

function scalarMeta(
  kind: string,
  pgType: string,
  opts: BaseOpts & { primaryKey?: boolean; check?: string } = {},
): ScalarFieldMeta {
  return {
    kind,
    pgType,
    required: opts.required ?? false,
    primaryKey: opts.primaryKey ?? false,
    unique: opts.unique ?? false,
    index: opts.index ?? false,
    ...(opts.default !== undefined && { default: opts.default }),
    ...(opts.check !== undefined && { check: opts.check }),
  }
}

// ─── Scalar fields ───────────────────────────────────────────────────────────

// For each field type, two overloads:
//   required: true  → Field<T>        (never null)
//   no required     → Field<T | null>  (nullable)

export function text(opts: TextOpts & { required: true }): Field<string>
export function text(opts?: TextOpts): Field<string | null>
export function text(opts: TextOpts = {}): Field<string> | Field<string | null> {
  const check = opts.maxLength ? `char_length("{name}") <= ${opts.maxLength}` : undefined
  return makeField(scalarMeta("text", "TEXT", { ...opts, ...(check && { check }) }))
}

export function richText(opts: BaseOpts & { required: true }): Field<Record<string, unknown>>
export function richText(opts?: BaseOpts): Field<Record<string, unknown> | null>
export function richText(opts: BaseOpts = {}): Field<Record<string, unknown>> | Field<Record<string, unknown> | null> {
  const meta: JsonFieldMeta = { kind: "richText", pgType: "JSONB", required: opts.required ?? false }
  return makeField(meta)
}

export function integer(opts: NumberOpts & { required: true }): Field<number>
export function integer(opts?: NumberOpts): Field<number | null>
export function integer(opts: NumberOpts = {}): Field<number> | Field<number | null> {
  const checks: string[] = []
  if (opts.min !== undefined) checks.push(`"{name}" >= ${opts.min}`)
  if (opts.max !== undefined) checks.push(`"{name}" <= ${opts.max}`)
  const check = checks.length ? checks.join(" AND ") : undefined
  return makeField(scalarMeta("integer", "INTEGER", { ...opts, ...(check && { check }) }))
}

export function float(opts: BaseOpts & { required: true }): Field<number>
export function float(opts?: BaseOpts): Field<number | null>
export function float(opts: BaseOpts = {}): Field<number> | Field<number | null> {
  return makeField(scalarMeta("float", "DOUBLE PRECISION", opts))
}

export function boolean(opts: BaseOpts & { required: true }): Field<boolean>
export function boolean(opts?: BaseOpts): Field<boolean | null>
export function boolean(opts: BaseOpts = {}): Field<boolean> | Field<boolean | null> {
  return makeField(scalarMeta("boolean", "BOOLEAN", opts))
}

export function datetime(opts: BaseOpts & { required: true }): Field<string>
export function datetime(opts?: BaseOpts): Field<string | null>
export function datetime(opts: BaseOpts = {}): Field<string> | Field<string | null> {
  return makeField(scalarMeta("datetime", "TIMESTAMPTZ", opts))
}

export function uuid(opts: BaseOpts & { required: true }): Field<string>
export function uuid(opts?: BaseOpts): Field<string | null>
export function uuid(opts: BaseOpts = {}): Field<string> | Field<string | null> {
  return makeField(scalarMeta("uuid", "UUID", opts))
}

export function email(opts: BaseOpts & { required: true }): Field<string>
export function email(opts?: BaseOpts): Field<string | null>
export function email(opts: BaseOpts = {}): Field<string> | Field<string | null> {
  return makeField(scalarMeta("email", "TEXT", opts))
}

export function bigInt(opts: BaseOpts & { required: true }): Field<string>
export function bigInt(opts?: BaseOpts): Field<string | null>
export function bigInt(opts: BaseOpts = {}): Field<string> | Field<string | null> {
  return makeField(scalarMeta("bigInt", "BIGINT", opts))
}

// ─── Slug ────────────────────────────────────────────────────────────────────

export function slug(opts: SlugOpts & { required: true }): Field<string>
export function slug(opts: SlugOpts): Field<string | null>
export function slug(opts: SlugOpts): Field<string> | Field<string | null> {
  const meta: SlugFieldMeta = {
    kind: "slug",
    pgType: "TEXT",
    required: opts.required ?? false,
    unique: opts.unique ?? true,
    from: opts.from,
  }
  return makeField(meta)
}

// ─── Enum ─────────────────────────────────────────────────────────────────────
// Uses TEXT + CHECK — NOT Postgres enum type (easier to alter migrations).

export function enumField<const T extends readonly string[]>(
  values: T,
  opts: EnumOpts & { required: true },
): Field<T[number]>
export function enumField<const T extends readonly string[]>(
  values: T,
  opts?: EnumOpts,
): Field<T[number] | null>
export function enumField<const T extends readonly string[]>(
  values: T,
  opts: EnumOpts = {},
): Field<T[number]> | Field<T[number] | null> {
  const meta: EnumFieldMeta = {
    kind: "enum",
    pgType: "TEXT",
    values,
    required: opts.required ?? false,
    unique: opts.unique ?? false,
    ...(opts.default !== undefined && { default: opts.default }),
  }
  return makeField(meta)
}

// ─── Decimal ─────────────────────────────────────────────────────────────────

export function decimal(opts: DecimalOpts & { required: true }): Field<string>
export function decimal(opts?: DecimalOpts): Field<string | null>
export function decimal(opts: DecimalOpts = {}): Field<string> | Field<string | null> {
  const pgType = opts.precision
    ? `NUMERIC(${opts.precision}${opts.scale !== undefined ? `, ${opts.scale}` : ""})`
    : "NUMERIC"
  const meta: DecimalFieldMeta = {
    kind: "decimal",
    pgType,
    required: opts.required ?? false,
    ...(opts.precision !== undefined && { precision: opts.precision }),
    ...(opts.scale !== undefined && { scale: opts.scale }),
  }
  return makeField(meta)
}

// ─── JSON ────────────────────────────────────────────────────────────────────

export function json<TShape = unknown>(opts: JsonOpts & { required: true }): Field<TShape>
export function json<TShape = unknown>(opts?: JsonOpts): Field<TShape | null>
export function json<TShape = unknown>(opts: JsonOpts = {}): Field<TShape> | Field<TShape | null> {
  const meta: JsonFieldMeta = { kind: "json", pgType: "JSONB", required: opts.required ?? false }
  return makeField(meta)
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export interface StorageReference {
  bucket: string
  path: string
  mimeType?: string
  size?: number
  metadata?: Record<string, unknown>
}

export function image(opts: StorageOpts & { required: true }): Field<StorageReference>
export function image(opts?: StorageOpts): Field<StorageReference | null>
export function image(opts: StorageOpts = {}): Field<StorageReference> | Field<StorageReference | null> {
  const meta: StorageFieldMeta = {
    kind: "image",
    pgType: "JSONB",
    required: opts.required ?? false,
    bucket: opts.bucket ?? "images",
  }
  return makeField(meta)
}

export function file(opts: StorageOpts & { required: true }): Field<StorageReference>
export function file(opts?: StorageOpts): Field<StorageReference | null>
export function file(opts: StorageOpts = {}): Field<StorageReference> | Field<StorageReference | null> {
  const meta: StorageFieldMeta = {
    kind: "file",
    pgType: "JSONB",
    required: opts.required ?? false,
    bucket: opts.bucket ?? "files",
  }
  return makeField(meta)
}

// ─── Geo ─────────────────────────────────────────────────────────────────────

export function geo(opts: GeoOpts & { required: true }): Field<object>
export function geo(opts?: GeoOpts): Field<object | null>
export function geo(opts: GeoOpts = {}): Field<object> | Field<object | null> {
  const geoType = opts.type ?? "point"
  const srid = opts.srid ?? 4326
  const meta: GeoFieldMeta = {
    kind: "geo",
    pgType: `GEOGRAPHY(${geoType.toUpperCase()}, ${srid})`,
    required: opts.required ?? false,
    geoType,
    ...(opts.srid !== undefined && { srid: opts.srid }),
  }
  return makeField(meta)
}

// ─── Vector ──────────────────────────────────────────────────────────────────

export function vector(opts: VectorOpts & { required: true }): Field<number[]>
export function vector(opts: VectorOpts): Field<number[] | null>
export function vector(opts: VectorOpts): Field<number[]> | Field<number[] | null> {
  const meta: VectorFieldMeta = {
    kind: "vector",
    pgType: `vector(${opts.dimensions})`,
    required: opts.required ?? false,
    dimensions: opts.dimensions,
  }
  return makeField(meta)
}

// ─── field namespace ─────────────────────────────────────────────────────────

export const field = {
  text,
  richText,
  integer,
  float,
  boolean,
  datetime,
  uuid,
  email,
  bigInt,
  slug,
  enum: enumField,
  decimal,
  json,
  image,
  file,
  geo,
  vector,
} as const
