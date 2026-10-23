/**
 * What Studio offers a signed-in user, from the permissions the server reported.
 *
 * One rule for every gate: only what the server has said is hidden. Before the capability
 * resolves, and on a host that does not report it, the control stays, and the server still
 * refuses what it should. The permission names are the shared role matrix's
 * (`role-matrix.json`), which the server enforces on every request.
 */
export interface OfferedCapability {
  role: string | null
  permissions: Record<string, boolean>
}

/** Whether Studio offers what `permission` covers. */
export function offers(capability: OfferedCapability, permission: string): boolean {
  return capability.role === null || capability.permissions[permission] === true
}

/** Creating, changing and deleting storage buckets: admins and developers. Listing them is reading. */
export function bucketManagementOffered(capability: OfferedCapability): boolean {
  return offers(capability, "manageBuckets")
}

/** The project's own users, through its auth admin API: admins and developers. */
export function userAdministrationOffered(capability: OfferedCapability): boolean {
  return offers(capability, "manageUsers")
}

/** Changing content (rows and files): every role but the viewer, who reads. */
export function contentWriteOffered(capability: OfferedCapability): boolean {
  return offers(capability, "write")
}

/** The project's API keys: admins and developers. */
export function projectKeysOffered(capability: OfferedCapability): boolean {
  return offers(capability, "manageKeys")
}

/**
 * Changing one user's account (disable, delete, email, password, sessions) when that user holds
 * the Studio role `targetStudioRole`. Only a Studio admin may change an admin's account; the server
 * refuses anyone else (`refusedAdminTarget` in the server's studioauth). Before the caller's role
 * is known the control stays, as every other offer does.
 */
export function adminAccountChangeOffered(capability: OfferedCapability, targetStudioRole: string | null): boolean {
  return targetStudioRole !== "admin" || capability.role === null || capability.role === "admin"
}

/** What a non-admin is told on an admin's account, in the server's own words for the refusal. */
export const ADMIN_ACCOUNT_LOCKED = "Only a Studio admin can change another admin's account."

/** Whether Studio offers what any one of `needs` covers. */
export function offersAny(capability: OfferedCapability, needs: string | readonly string[]): boolean {
  return typeof needs === "string" ? offers(capability, needs) : needs.some((need) => offers(capability, need))
}

/** The permission a refusal names: the first of several, any of which would have done. */
export function firstNeed(needs: string | readonly string[]): string {
  return typeof needs === "string" ? needs : (needs[0] ?? "administer")
}
