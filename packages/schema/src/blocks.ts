import type { AnyField, BlockFieldMeta, Field } from "./types.js"

// ─── Block definition ───────────────────────────────────────────────────────────

export interface BlockDefinition<TFields extends Record<string, AnyField> = Record<string, AnyField>> {
  /** Unique block type name (used as discriminator in JSONB). */
  name: string
  /** Optional icon identifier for the admin panel block picker. */
  icon?: string
  /** Optional human-readable label. Defaults to the block name. */
  label?: string
  /** Fields within this block type. */
  fields: TFields
}

/**
 * Define a block type for use with `field.blocks()`.
 *
 * @example
 * ```ts
 * const HeroBlock = block("hero", {
 *   fields: {
 *     heading: field.text({ required: true }),
 *     image: field.image({ bucket: "hero-images" }),
 *   },
 * })
 * ```
 */
export function block<TFields extends Record<string, AnyField>>(
  name: string,
  definition: { fields: TFields; icon?: string; label?: string },
): BlockDefinition<TFields> {
  return {
    name,
    fields: definition.fields,
    ...(definition.icon !== undefined && { icon: definition.icon }),
    ...(definition.label !== undefined && { label: definition.label }),
  }
}

// ─── Block data type inference ──────────────────────────────────────────────────

/** Infer the discriminated union type from an array of block definitions. */
export type BlockData<TBlocks extends readonly BlockDefinition[]> = {
  [K in keyof TBlocks]: TBlocks[K] extends BlockDefinition<infer TFields>
    ? { type: TBlocks[K]["name"]; data: { [F in keyof TFields]: TFields[F] extends Field<infer V> ? V : never } }
    : never
}[number]

interface BlocksOpts {
  required?: boolean
  maxNestingDepth?: number
}

/**
 * A field that stores an ordered array of typed blocks as JSONB.
 *
 * @example
 * ```ts
 * const Page = model("page", {
 *   fields: {
 *     content: field.blocks([HeroBlock, TextBlock, ImageBlock]),
 *   },
 * })
 * ```
 */
export function blocks<const T extends readonly BlockDefinition[]>(
  blockTypes: T,
  opts: BlocksOpts & { required: true },
): Field<BlockData<T>[]>
export function blocks<const T extends readonly BlockDefinition[]>(
  blockTypes: T,
  opts?: BlocksOpts,
): Field<BlockData<T>[] | null>
export function blocks<const T extends readonly BlockDefinition[]>(
  blockTypes: T,
  opts: BlocksOpts = {},
): Field<BlockData<T>[]> | Field<BlockData<T>[] | null> {
  const meta: BlockFieldMeta = {
    kind: "blocks",
    pgType: "JSONB",
    required: opts.required ?? false,
    blockTypes: blockTypes as unknown as BlockFieldMeta["blockTypes"],
    maxNestingDepth: opts.maxNestingDepth ?? 3,
  }
  return { __type: undefined as unknown as BlockData<T>[], __meta: meta } as Field<BlockData<T>[]>
}
