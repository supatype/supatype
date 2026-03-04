import type { Field } from "./types.js"

// ─── Composite fields ─────────────────────────────────────────────────────────
// These expand to multiple columns when the engine processes them.

export interface TimestampsFields {
  createdAt: Field<string>
  updatedAt: Field<string>
}

export interface PublishableFields {
  status: Field<"draft" | "published" | "scheduled" | "archived">
  publishedAt: Field<string | null>
  scheduledAt: Field<string | null>
}

export interface SoftDeleteFields {
  deletedAt: Field<string | null>
}

function composite<TOutput>(kind: string): Field<TOutput> {
  return { __type: undefined as TOutput, __meta: { kind } } as Field<TOutput>
}

/**
 * Adds `created_at` and `updated_at` TIMESTAMPTZ columns with an
 * auto-update trigger on `updated_at`.
 */
export const timestamps = (): Field<{ createdAt: string; updatedAt: string }> =>
  composite("timestamps")

/**
 * Adds `status` (draft|published|scheduled|archived), `published_at`,
 * and `scheduled_at` columns with a publish workflow.
 */
export const publishable = (): Field<{
  status: "draft" | "published" | "scheduled" | "archived"
  publishedAt: string | null
  scheduledAt: string | null
}> => composite("publishable")

/**
 * Adds a `deleted_at` TIMESTAMPTZ column for soft deletion.
 */
export const softDelete = (): Field<{ deletedAt: string | null }> =>
  composite("softDelete")

export const composites = { timestamps, publishable, softDelete } as const
