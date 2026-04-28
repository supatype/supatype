import type {
  AnyField,
  BlockFieldMeta,
  BucketAst,
  BucketDef,
  EnumFieldMeta,
  FieldAst,
  ModelAst,
  ModelDefinition,
  RelationMeta,
  SchemaAst,
  StorageFieldMeta,
} from "./types.js"
import type { GlobalDefinition } from "./globals.js"

// ─── Schema AST with globals ────────────────────────────────────────────────────

export interface SchemaAstWithGlobals extends SchemaAst {
  globals?: Array<{
    name: string
    tableName: string
    fields: Record<string, FieldAst>
    access: ModelAst["access"]
  }>
}

function bucketDefToAst(def: BucketDef): BucketAst {
  return {
    id: def.name,
    public: def.accessMode === "public",
    ...(def.accept !== undefined && { allowedMimeTypes: def.accept }),
    ...(def.maxSize !== undefined && { fileSizeLimit: def.maxSize }),
  }
}

/**
 * Serialise a map of model definitions to the JSON AST consumed by the
 * Supatype engine binary.
 *
 * @param models  Named model definitions from the schema file.
 * @param globals Named global definitions (optional).
 * @param localeConfig Locale configuration (optional).
 * @param explicitBuckets Named BucketDef exports from the schema file. These
 *   are created even if no model field references them — useful for buckets
 *   used by direct uploads or external services.
 *
 * @example
 * ```ts
 * import { serialiseSchema } from '@supatype/schema'
 * const ast = serialiseSchema({ User, Post, Category })
 * process.stdout.write(JSON.stringify(ast))
 * // pipe to: supatype-engine parse
 * ```
 */
export function serialiseSchema(
  models: Record<string, ModelDefinition<Record<string, AnyField>>>,
  globals?: Record<string, GlobalDefinition<Record<string, AnyField>>>,
  localeConfig?: { locales: string[]; defaultLocale: string },
  explicitBuckets?: Record<string, BucketDef>,
): SchemaAstWithGlobals {
  const buckets = new Map<string, BucketAst>()

  // Seed with explicitly exported buckets first (field refs will overwrite with
  // identical data — both come from the same BucketDef, so order doesn't matter).
  if (explicitBuckets) {
    for (const def of Object.values(explicitBuckets)) {
      buckets.set(def.name, bucketDefToAst(def))
    }
  }

  const ast: SchemaAstWithGlobals = {
    models: Object.values(models).map((def) => serialiseModel(def, buckets)),
    ...(localeConfig !== undefined && {
      locales: localeConfig.locales,
      defaultLocale: localeConfig.defaultLocale,
    }),
  }

  if (globals && Object.keys(globals).length > 0) {
    ast.globals = Object.values(globals).map((def) => serialiseGlobal(def, buckets))
  }

  if (buckets.size > 0) {
    ast.storageBuckets = [...buckets.values()]
  }

  return ast
}

function serialiseModel(
  def: ModelDefinition<Record<string, AnyField>>,
  buckets: Map<string, BucketAst>,
): ModelAst {
  const { name, tableName, fields, access, indexes, options, hooks } = def.__modelMeta

  return {
    name,
    tableName,
    fields: serialiseFields(fields, buckets),
    access,
    indexes,
    options,
    ...(hooks !== undefined && hooks.length > 0 && { hooks }),
  }
}

function serialiseGlobal(
  def: GlobalDefinition<Record<string, AnyField>>,
  buckets: Map<string, BucketAst>,
): SchemaAstWithGlobals["globals"] extends Array<infer T> | undefined ? T : never {
  const { name, tableName, fields, access } = def.__globalMeta
  return {
    name,
    tableName,
    fields: serialiseFields(fields, buckets),
    access,
  }
}

function serialiseFields(
  fields: Record<string, AnyField>,
  buckets: Map<string, BucketAst>,
): Record<string, FieldAst> {
  const result: Record<string, FieldAst> = {}

  for (const [name, field] of Object.entries(fields)) {
    const meta = field.__meta

    if (meta.kind === "relation") {
      const rel = meta as RelationMeta
      // Derive foreignKey from field name when not explicit (e.g. "author" → "author_id")
      const derivedForeignKey = rel.foreignKey ?? `${name}_id`
      result[name] = {
        kind: "relation",
        cardinality: rel.cardinality,
        target: rel.target,
        foreignKey: derivedForeignKey,
        ...(rel.references !== undefined && { references: rel.references }),
        ...(rel.through !== undefined && { through: rel.through }),
        ...(rel.onDelete !== undefined && { onDelete: rel.onDelete }),
        ...(rel.onUpdate !== undefined && { onUpdate: rel.onUpdate }),
      }
      continue
    }

    if (meta.kind === "timestamps" || meta.kind === "publishable" || meta.kind === "softDelete") {
      result[name] = { kind: meta.kind }
      continue
    }

    if (meta.kind === "enum") {
      const m = meta as EnumFieldMeta
      result[name] = {
        kind: "enum",
        pgType: m.nativeType ? (m.nativeTypeName ?? m.pgType) : "TEXT",
        values: [...m.values],
        required: m.required,
        unique: m.unique,
        ...(m.default !== undefined && { default: m.default }),
        ...(m.nativeType && { nativeType: true }),
        ...(m.nativeTypeName !== undefined && { nativeTypeName: m.nativeTypeName }),
      }
      continue
    }

    if (meta.kind === "blocks") {
      const m = meta as BlockFieldMeta
      result[name] = {
        kind: "blocks",
        pgType: "JSONB",
        required: m.required,
        maxNestingDepth: m.maxNestingDepth,
        blocks: m.blockTypes.map((bt) => ({
          name: bt.name,
          ...(bt.icon !== undefined && { icon: bt.icon }),
          ...(bt.label !== undefined && { label: bt.label }),
          fields: serialiseFields(bt.fields as Record<string, AnyField>, buckets),
        })),
      }
      continue
    }

    if (meta.kind === "image" || meta.kind === "file") {
      const m = meta as StorageFieldMeta
      // Collect the bucket definition — first writer wins (all writers carry the
      // same BucketDef, so the result is always identical).
      if (!buckets.has(m.bucketDef.name)) {
        buckets.set(m.bucketDef.name, bucketDefToAst(m.bucketDef))
      }
      // Emit the field AST without the internal bucketDef reference.
      result[name] = {
        kind: m.kind,
        pgType: m.pgType,
        required: m.required,
        unique: false,
        bucket: m.bucket,
        accessMode: m.accessMode,
        ...(m.maxSize !== undefined && { maxSize: m.maxSize }),
        ...(m.accept !== undefined && { accept: m.accept }),
        ...(m.signedUrlExpiry !== undefined && { signedUrlExpiry: m.signedUrlExpiry }),
      }
      continue
    }

    // All other scalar/geo/vector fields.
    // Default unique:false so the engine always receives the required field,
    // even for types like richText/geo/vector that don't expose it.
    const { kind, ...rest } = meta as Record<string, unknown> & { kind: string }
    result[name] = { kind, unique: false, ...rest } as FieldAst
  }

  return result
}
