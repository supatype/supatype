import type { Relation, RelationMeta } from "./types.js"

interface BelongsToOpts {
  foreignKey?: string
  references?: string
  required?: boolean
  onDelete?: "cascade" | "restrict" | "setNull" | "setDefault" | "noAction"
  onUpdate?: "cascade" | "restrict" | "setNull" | "setDefault" | "noAction"
}

interface HasManyOpts {
  foreignKey?: string
}

interface HasOneOpts {
  foreignKey?: string
}

interface ManyToManyOpts {
  through?: string
}

function makeRelation<TOutput>(meta: RelationMeta): Relation<TOutput> {
  return { __type: undefined as TOutput, __meta: meta } as Relation<TOutput>
}

/**
 * Generates a FK column `{name}_id` on the current table pointing to `target`.
 */
export function belongsTo<TModel>(
  target: string,
  opts: BelongsToOpts = {},
): Relation<TModel | null> {
  const meta: RelationMeta = {
    kind: "relation",
    cardinality: "belongsTo",
    target,
    ...(opts.foreignKey !== undefined && { foreignKey: opts.foreignKey }),
    ...(opts.references !== undefined && { references: opts.references }),
    ...(opts.onDelete !== undefined && { onDelete: opts.onDelete }),
    ...(opts.onUpdate !== undefined && { onUpdate: opts.onUpdate }),
  }
  return makeRelation(meta)
}

/**
 * Virtual relation — no column on this table.
 * The FK lives on the target model.
 */
export function hasMany<TModel>(
  target: string,
  opts: HasManyOpts = {},
): Relation<TModel[]> {
  const meta: RelationMeta = {
    kind: "relation",
    cardinality: "hasMany",
    target,
    ...(opts.foreignKey !== undefined && { foreignKey: opts.foreignKey }),
  }
  return makeRelation(meta)
}

/**
 * Virtual relation (unique FK on target). No column on this table.
 */
export function hasOne<TModel>(
  target: string,
  opts: HasOneOpts = {},
): Relation<TModel | null> {
  const meta: RelationMeta = {
    kind: "relation",
    cardinality: "hasOne",
    target,
    ...(opts.foreignKey !== undefined && { foreignKey: opts.foreignKey }),
  }
  return makeRelation(meta)
}

/**
 * Generates a junction table with composite PK.
 */
export function manyToMany<TModel>(
  target: string,
  opts: ManyToManyOpts = {},
): Relation<TModel[]> {
  const meta: RelationMeta = {
    kind: "relation",
    cardinality: "manyToMany",
    target,
    ...(opts.through !== undefined && { through: opts.through }),
  }
  return makeRelation(meta)
}

export const relation = { belongsTo, hasMany, hasOne, manyToMany } as const
