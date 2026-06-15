import type { SupatypeProjectConfig } from "./project-config.js"

export const DEFAULT_STUDIO_ADMIN_ROLES = ["admin", "supatype_admin"] as const

/** Studio admin roles from `supatype.config.ts` `admin.roles` or defaults. */
export function studioAdminRoles(cfg: SupatypeProjectConfig): string[] {
  const roles = cfg.admin?.roles
  if (roles !== undefined && roles.length > 0) return roles
  return [...DEFAULT_STUDIO_ADMIN_ROLES]
}

/** Merge `adminRoles` into engine admin-config JSON for Studio and supatype-server. */
export function withAdminRoles(admin: unknown, cfg: SupatypeProjectConfig): Record<string, unknown> {
  const base = typeof admin === "object" && admin !== null ? (admin as Record<string, unknown>) : {}
  return { ...base, adminRoles: studioAdminRoles(cfg) }
}
