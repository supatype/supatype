import type { AnyField, ModelDefinition, ModelRow, Relation, RelationMeta, SystemModelRef } from "./types.js"

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

type AnyModelDef = ModelDefinition<Record<string, AnyField>>
type AnySystemRef = SystemModelRef<unknown>

/** Resolve a relation target to the string stored in RelationMeta. */
function resolveTarget(target: AnyModelDef | AnySystemRef | string): string {
  if (typeof target === "string") return target
  if ("__systemToken" in target) return (target as AnySystemRef).__systemToken
  return (target as AnyModelDef).__modelMeta.name
}

function makeRelation<TOutput>(meta: RelationMeta): Relation<TOutput> {
  return { __type: undefined as TOutput, __meta: meta } as Relation<TOutput>
}

// ─── belongsTo ───────────────────────────────────────────────────────────────

/**
 * Generates a FK column `{name}_id` on the current table pointing to `target`.
 *
 * Pass a model definition or a `supatype.*` system ref for full type inference
 * and engine-managed schema resolution. A raw string is also accepted as an
 * escape hatch for external tables.
 *
 * @example
 * ```ts
 * // User-defined model — type inferred from fields
 * author: relation.belongsTo(User, { onDelete: 'cascade' })
 *
 * // Supatype system model — resolves to auth.users (all environments)
 * author: relation.belongsTo(supatype.user, { onDelete: 'cascade' })
 *
 * // External table — escape hatch, no type inference
 * ref: relation.belongsTo<ExternalRow>("legacy_schema.table")
 * ```
 */
export function belongsTo<TFields extends Record<string, AnyField>>(
  target: ModelDefinition<TFields>,
  opts?: BelongsToOpts,
): Relation<ModelRow<TFields> | null>
export function belongsTo<TRow>(
  target: SystemModelRef<TRow>,
  opts?: BelongsToOpts,
): Relation<TRow | null>
export function belongsTo<TModel = unknown>(
  target: string,
  opts?: BelongsToOpts,
): Relation<TModel | null>
export function belongsTo(
  target: AnyModelDef | AnySystemRef | string,
  opts: BelongsToOpts = {},
): Relation<unknown> {
  const meta: RelationMeta = {
    kind: "relation",
    cardinality: "belongsTo",
    target: resolveTarget(target),
    ...(opts.foreignKey !== undefined && { foreignKey: opts.foreignKey }),
    ...(opts.references !== undefined && { references: opts.references }),
    ...(opts.onDelete !== undefined && { onDelete: opts.onDelete }),
    ...(opts.onUpdate !== undefined && { onUpdate: opts.onUpdate }),
  }
  return makeRelation(meta)
}

// ─── hasMany ─────────────────────────────────────────────────────────────────

/**
 * Virtual relation — no column on this table. The FK lives on the target model.
 */
export function hasMany<TFields extends Record<string, AnyField>>(
  target: ModelDefinition<TFields>,
  opts?: HasManyOpts,
): Relation<ModelRow<TFields>[]>
export function hasMany<TRow>(
  target: SystemModelRef<TRow>,
  opts?: HasManyOpts,
): Relation<TRow[]>
export function hasMany<TModel = unknown>(
  target: string,
  opts?: HasManyOpts,
): Relation<TModel[]>
export function hasMany(
  target: AnyModelDef | AnySystemRef | string,
  opts: HasManyOpts = {},
): Relation<unknown[]> {
  const meta: RelationMeta = {
    kind: "relation",
    cardinality: "hasMany",
    target: resolveTarget(target),
    ...(opts.foreignKey !== undefined && { foreignKey: opts.foreignKey }),
  }
  return makeRelation(meta)
}

// ─── hasOne ──────────────────────────────────────────────────────────────────

/**
 * Virtual relation (unique FK on target). No column on this table.
 */
export function hasOne<TFields extends Record<string, AnyField>>(
  target: ModelDefinition<TFields>,
  opts?: HasOneOpts,
): Relation<ModelRow<TFields> | null>
export function hasOne<TRow>(
  target: SystemModelRef<TRow>,
  opts?: HasOneOpts,
): Relation<TRow | null>
export function hasOne<TModel = unknown>(
  target: string,
  opts?: HasOneOpts,
): Relation<TModel | null>
export function hasOne(
  target: AnyModelDef | AnySystemRef | string,
  opts: HasOneOpts = {},
): Relation<unknown> {
  const meta: RelationMeta = {
    kind: "relation",
    cardinality: "hasOne",
    target: resolveTarget(target),
    ...(opts.foreignKey !== undefined && { foreignKey: opts.foreignKey }),
  }
  return makeRelation(meta)
}

// ─── manyToMany ──────────────────────────────────────────────────────────────

/**
 * Generates a junction table with composite PK.
 */
export function manyToMany<TFields extends Record<string, AnyField>>(
  target: ModelDefinition<TFields>,
  opts?: ManyToManyOpts,
): Relation<ModelRow<TFields>[]>
export function manyToMany<TRow>(
  target: SystemModelRef<TRow>,
  opts?: ManyToManyOpts,
): Relation<TRow[]>
export function manyToMany<TModel = unknown>(
  target: string,
  opts?: ManyToManyOpts,
): Relation<TModel[]>
export function manyToMany(
  target: AnyModelDef | AnySystemRef | string,
  opts: ManyToManyOpts = {},
): Relation<unknown[]> {
  const meta: RelationMeta = {
    kind: "relation",
    cardinality: "manyToMany",
    target: resolveTarget(target),
    ...(opts.through !== undefined && { through: opts.through }),
  }
  return makeRelation(meta)
}

export const relation = { belongsTo, hasMany, hasOne, manyToMany } as const
