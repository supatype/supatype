import type { Model, Owner, PrimaryKey, RelatedTo, Role, SupatypeAuthUserId, UUID } from "@supatype/types"

/**
 * The models `realtime-visibility.ts` needs, as a project schema (`schema/index.ts`).
 *
 * Every table is owner-only to read and written by the service role, so each test can write a
 * stranger's row and the subscriber's own, and check which of the two arrives.
 */

/** Owners for the realtime tables. */
export type member = Model<{
  id: UUID
  name: string
}, { access: { read: Role<"service_role">; create: Role<"service_role">; update: Role<"service_role">; delete: Role<"service_role"> } }>

/** M06 A: an owner-only table keyed by `id`, for the DELETE leak. */
export type rt_item = Model<{
  id: UUID
  owner: RelatedTo<member, { required: true; onDelete: "cascade" }>
  label: string
}, { access: { read: Owner<"owner_id">; create: Role<"service_role">; update: Role<"service_role">; delete: Role<"service_role"> } }>

/** M06 B: the key is not `id`, and the first column is a value many rows share. */
export type rt_ticket = Model<{
  category: string
  code: PrimaryKey<UUID>
  owner: RelatedTo<member, { required: true; onDelete: "cascade" }>
  label: string
}, { access: { read: Owner<"owner_id">; create: Role<"service_role">; update: Role<"service_role">; delete: Role<"service_role"> } }>

/** P03: one note per user, keyed by the user's own id. */
export type note = Model<{
  id: SupatypeAuthUserId
  body: string
}, { access: { read: Owner<"id">; create: Owner<"id">; update: Owner<"id">; delete: Owner<"id"> } }>

/** T1-N3: a numeric column for a `gt` filter. */
export type rt_score = Model<{
  id: UUID
  owner: RelatedTo<member, { required: true; onDelete: "cascade" }>
  points: number
}, { access: { read: Owner<"owner_id">; create: Role<"service_role">; update: Role<"service_role">; delete: Role<"service_role"> } }>
