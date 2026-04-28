import type { SystemModelRef } from "./types.js"

/**
 * The shape of a Supatype auth user (GoTrue `auth.users`).
 *
 * Only developer-relevant fields are included — internal GoTrue columns
 * (encrypted_password, confirmation_token, recovery_token, etc.) are omitted.
 */
export interface SupatypeUser {
  id: string
  aud: string
  role: string | null
  email: string | null
  phone: string | null
  created_at: string | null
  updated_at: string | null
  email_confirmed_at: string | null
  phone_confirmed_at: string | null
  last_sign_in_at: string | null
  raw_app_meta_data: Record<string, unknown>
  raw_user_meta_data: Record<string, unknown>
}

function systemRef<TRow>(token: string): SystemModelRef<TRow> {
  return { __systemToken: token } as SystemModelRef<TRow>
}

/**
 * Typed references to Supatype-managed system tables.
 *
 * Use these as `relation.belongsTo()` / `relation.hasMany()` targets instead
 * of raw schema-qualified strings like `"auth.users"`. The engine resolves
 * each token to the correct table at deploy time, handling schema differences
 * across environments automatically:
 *
 * - **Local dev** — standard `auth.users` (GoTrue default schema)
 * - **Free cloud** — shared Postgres with per-project namespaced schemas
 *   (e.g. `project_abc123_auth.users`) — resolved automatically
 * - **Pro / Team / Enterprise** — dedicated Postgres, standard schema names
 *
 * ## Available system models
 *
 * - `supatype.user` — the authenticated user record (`auth.users`)
 *
 * ## Planned system models (Phase 12 — Multi-Tenancy)
 *
 * When multi-tenancy is added, the following system models will be introduced.
 * Any model that references an organisation or membership table **must** use
 * these references (not raw strings) so the engine applies the same
 * schema-alias resolution:
 *
 * - `supatype.organisation` — the tenant organisation
 *   (auto-generated `_supatype_organisations` table, configured via
 *   `tenancy.tenantModel` in `supatype.config.toml`)
 * - `supatype.membership` — user ↔ organisation link with role
 *   (auto-generated `_supatype_memberships` table)
 *
 * @example
 * ```ts
 * import { model, field, relation, supatype } from '@supatype/schema'
 *
 * const Post = model('post', {
 *   fields: {
 *     title:  field.text({ required: true }),
 *     author: relation.belongsTo(supatype.user, { onDelete: 'cascade' }),
 *   },
 * })
 *
 * // Phase 12 — when tenancy is enabled:
 * // const Project = model('project', {
 * //   fields: {
 * //     org: relation.belongsTo(supatype.organisation),
 * //   },
 * //   options: { tenanted: true },
 * // })
 * ```
 */
export const supatype = {
  user: systemRef<SupatypeUser>("supatype:user"),
} as const
