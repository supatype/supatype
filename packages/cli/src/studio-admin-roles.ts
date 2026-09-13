import type { SupatypeProjectConfig } from "./project-config.js"

export const DEFAULT_STUDIO_ADMIN_ROLES = ["admin", "supatype_admin"] as const

/** Studio admin roles from `supatype.config.ts` `admin.roles` or defaults. */
export function studioAdminRoles(cfg: SupatypeProjectConfig): string[] {
  const roles = cfg.admin?.roles
  if (roles !== undefined && roles.length > 0) return roles
  return [...DEFAULT_STUDIO_ADMIN_ROLES]
}

/**
 * Merge the project's own settings into engine admin-config JSON for Studio and supatype-server.
 *
 * The engine derives everything it can from the schema. These two cannot be derived from it: which
 * JWT roles may open Studio, and where the project's front end renders each model. Both are facts
 * about a deployment rather than about a shape, so they live in `supatype.config.ts` and are folded
 * in here, at the one place the file is written.
 */
export function withAdminRoles(admin: unknown, cfg: SupatypeProjectConfig): Record<string, unknown> {
  const base = typeof admin === "object" && admin !== null ? (admin as Record<string, unknown>) : {}
  const livePreview = cfg.admin?.livePreview
  return {
    ...base,
    adminRoles: studioAdminRoles(cfg),
    // Omitted rather than written empty: Studio treats an absent entry as "this project has not
    // said", which is what drives the message asking for it.
    ...(livePreview !== undefined && Object.keys(livePreview).length > 0 && { livePreview }),
  }
}
