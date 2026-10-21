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
