/**
 * The Studio roles a self-hosted project grants, most privileged first.
 *
 * One role set serves both hosts: `role-matrix.json` beside this file is the document
 * supatype-server embeds and the control plane carries, each pinning its hash, and it says what each
 * role may do. Self-host grants admin, developer, editor and viewer; owner and billing are Cloud org
 * roles. Capability checks refuse a role they do not recognise, so granting one the server does not
 * know would create a user locked out of the very panel they were made for. `tests/role-matrix.test.ts`
 * checks this list against the document.
 */
export const STUDIO_ROLES = ["admin", "developer", "editor", "viewer"] as const

export type StudioRole = (typeof STUDIO_ROLES)[number]
