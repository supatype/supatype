import type {
  AnyField,
  EnumFieldMeta,
  FieldAst,
  ModelAst,
  ModelDefinition,
  RelationMeta,
  SchemaAst,
} from "./types.js"

/**
 * Serialise a map of model definitions to the JSON AST consumed by the
 * Definatype engine binary.
 *
 * @example
 * ```ts
 * import { serialiseSchema } from '@definatype/schema'
 * const ast = serialiseSchema({ User, Post, Category })
 * process.stdout.write(JSON.stringify(ast))
 * // pipe to: definatype-engine parse
 * ```
 */
export function serialiseSchema(
  models: Record<string, ModelDefinition<Record<string, AnyField>>>,
): SchemaAst {
  return {
    models: Object.values(models).map(serialiseModel),
  }
}

function serialiseModel(
  def: ModelDefinition<Record<string, AnyField>>,
): ModelAst {
  const { name, tableName, fields, access, indexes, options } = def.__modelMeta

  return {
    name,
    tableName,
    fields: serialiseFields(fields),
    access,
    indexes,
    options,
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

    // All other scalar/storage/geo/vector fields
    const { kind, ...rest } = meta as Record<string, unknown> & { kind: string }
    result[name] = { kind, ...rest } as FieldAst
  }

  return result
}
