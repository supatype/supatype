import type {
  AccessDef,
  AnyField,
  IndexDef,
  ModelDefinition,
  ModelMeta,
  ModelOptions,
} from "./types.js"
import type { HooksDef } from "./hooks.js"
import { resolveHooks } from "./hooks.js"

interface ModelDefinitionInput<TFields extends Record<string, AnyField>> {
  fields: TFields
  access?: AccessDef
  indexes?: IndexDef[]
  options?: ModelOptions
  hooks?: HooksDef
  tableName?: string
}

/**
 * Define a data model.
 *
 * @example
 * ```ts
 * const Post = model('post', {
 *   fields: {
 *     id:      field.uuid({ required: true, default: { kind: 'genRandomUuid' } }),
 *     title:   field.text({ required: true }),
 *     author:  relation.belongsTo('user', { foreignKey: 'author_id', onDelete: 'cascade' }),
 *   },
 *   access: {
 *     read:   access.public(),
 *     create: access.role('admin', 'editor'),
 *     update: access.owner('author_id'),
 *     delete: access.role('admin'),
 *   },
 *   hooks: {
 *     beforeChange: "./hooks/post-before-change.ts",
 *     afterChange:  "./hooks/post-after-change.ts",
 *   },
 *   options: { timestamps: true },
 * })
 * ```
 */
export function model<TFields extends Record<string, AnyField>>(
  name: string,
  definition: ModelDefinitionInput<TFields>,
): ModelDefinition<TFields> {
  const tableName = definition.tableName ?? toSnakeCase(name)

  const meta: ModelMeta = {
    name,
    tableName,
    fields: definition.fields,
    access: definition.access ?? {},
    indexes: definition.indexes ?? [],
    options: definition.options ?? {},
    ...(definition.hooks !== undefined && { hooks: resolveHooks(definition.hooks) }),
  }

  return {
    __modelMeta: meta,
    fields: definition.fields,
  }
}

function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z])/g, (_, c: string, i: number) => (i > 0 ? "_" : "") + c.toLowerCase())
    .replace(/\s+/g, "_")
    .toLowerCase()
}
