import type {
  AnyField,
  BlockFieldMeta,
  EnumFieldMeta,
  FieldAst,
  ModelAst,
  ModelDefinition,
  RelationMeta,
  SchemaAst,
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

/**
 * Serialise a map of model definitions to the JSON AST consumed by the
 * Supatype engine binary.
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
): SchemaAstWithGlobals {
  const ast: SchemaAstWithGlobals = {
    models: Object.values(models).map(serialiseModel),
  }

  if (globals && Object.keys(globals).length > 0) {
    ast.globals = Object.values(globals).map(serialiseGlobal)
  }

  return ast
}

function serialiseModel(
  def: ModelDefinition<Record<string, AnyField>>,
): ModelAst {
  const { name, tableName, fields, access, indexes, options, hooks } = def.__modelMeta

  return {
    name,
    tableName,
    fields: serialiseFields(fields),
    access,
    indexes,
    options,
    ...(hooks !== undefined && hooks.length > 0 && { hooks }),
  }
}

function serialiseGlobal(
  def: GlobalDefinition<Record<string, AnyField>>,
): SchemaAstWithGlobals["globals"] extends Array<infer T> | undefined ? T : never {
  const { name, tableName, fields, access } = def.__globalMeta
  return {
    name,
    tableName,
    fields: serialiseFields(fields),
    access,
  }
}

function serialiseFields(
  fields: Record<string, AnyField>,
): Record<string, FieldAst> {
  const result: Record<string, FieldAst> = {}

  for (const [name, field] of Object.entries(fields)) {
    const meta = field.__meta

    if (meta.kind === "relation") {
      const rel = meta as RelationMeta
      result[name] = {
        kind: "relation",
        cardinality: rel.cardinality,
        target: rel.target,
        ...(rel.foreignKey !== undefined && { foreignKey: rel.foreignKey }),
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
        pgType: "TEXT",
        values: [...m.values],
        required: m.required,
        unique: m.unique,
        ...(m.default !== undefined && { default: m.default }),
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
        blockTypes: m.blockTypes.map((bt) => ({
          name: bt.name,
          ...(bt.icon !== undefined && { icon: bt.icon }),
          ...(bt.label !== undefined && { label: bt.label }),
          fields: serialiseFields(bt.fields as Record<string, AnyField>),
        })),
      }
      continue
    }

    // All other scalar/storage/geo/vector fields
    const { kind, ...rest } = meta as Record<string, unknown> & { kind: string }
    result[name] = { kind, ...rest } as FieldAst
  }

  return result
}
