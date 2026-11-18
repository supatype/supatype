/**
 * `supatype admin` against a Supatype Cloud project.
 *
 * On self-host the commands write the project's own database: a password user in `auth.users` and a
 * row in `_supatype.studio_members`. A Cloud project's Studio is entered with a Supatype Cloud
 * account instead, and who may enter is its organisation's membership, which a project row can only
 * narrow (never widen). So on Cloud the commands go through the control plane's routes:
 *
 * - `list-users`: the organisation's members, each with the role they hold on this project.
 * - `set-role`:   `PATCH /projects/:slug/studio-members/:userId`, narrowing an org member's role here.
 * - `create-user`: an invitation to the organisation with that role. The person sets their own
 *   password from the invitation email, so `--password` is refused. An org role applies to every
 *   project in the organisation; narrow it for this one with `set-role` once they have joined.
 */

import { isArrayOf, isShape, isString, isUnknown, nullable } from "@supatype/shared"
import { loadProjectLink } from "./link.js"
import { apiFetchOpts, projectRequest, resolveTarget, type DeployTarget } from "./resolve-target.js"
import { targetFetch } from "./target-client.js"

/** An organisation member as `GET /organisations/:id/members` lists one. */
const isOrgMember = isShape({ userId: isString, email: isString, role: isString, createdAt: isUnknown })
/** A project's Studio grant as `GET /projects/:slug/studio-members` lists one. */
const isProjectGrant = isShape({ id: isString, role: isString, platformAccount: isUnknown, email: nullable(isString) })

/** An organisation member, as the members list gives one. */
type OrgMember = { userId: string; email: string; role: string; createdAt: unknown }

/** One Studio user of a Cloud project: who, the role that applies here, and where it comes from. */
export interface CloudStudioUser {
  id: string
  email: string
  role: string
  /** "org" when the organisation role applies, "project" when a row narrows it for this project. */
  source: "org" | "project"
  createdAt: unknown
}

/** The Cloud project `cwd` is linked to, when the command is not pointed elsewhere by `--connection`. */
export function cloudAdminTarget(cwd: string, connection: string | undefined): DeployTarget | null {
  if (connection !== undefined) return null
  if (loadProjectLink(cwd)?.kind !== "cloud") return null
  return resolveTarget(cwd)
}

function orgIdOf(target: DeployTarget): string {
  if (target.orgId === undefined) throw new Error("The project link names no organisation. Run `supatype link` again.")
  return target.orgId
}

/** The organisation's members, as the control plane lists them. */
async function orgMembers(target: DeployTarget): Promise<Array<OrgMember>> {
  const path = `/organisations/${orgIdOf(target)}/members`
  return targetFetch(target.apiBaseUrl, target.apiPrefix, apiFetchOpts(target, "GET", path), isArrayOf(isOrgMember))
}

/** Every org member with the role that applies on this project: a project row narrows the org role. */
export function effectiveStudioUsers(
  members: ReadonlyArray<OrgMember>,
  grants: ReadonlyArray<{ id: string; role: string }>,
): CloudStudioUser[] {
  const narrowed = new Map(grants.map((grant) => [grant.id, grant.role]))
  return members.map((member) => {
    const projectRole = narrowed.get(member.userId)
    return {
      id: member.userId,
      email: member.email,
      role: projectRole ?? member.role,
      source: projectRole === undefined ? "org" : "project",
      createdAt: member.createdAt,
    }
  })
}

/** `list-users` on Cloud. */
export async function listCloudStudioUsers(target: DeployTarget): Promise<CloudStudioUser[]> {
  const [members, grants] = await Promise.all([
    orgMembers(target),
    targetFetch(target.apiBaseUrl, target.apiPrefix, projectRequest(target, "GET", "/studio-members"), isArrayOf(isProjectGrant)),
  ])
  return effectiveStudioUsers(members, grants)
}

/** `set-role` on Cloud: the org member with `email`, narrowed to `role` on this project. Returns their id. */
export async function setCloudStudioRole(target: DeployTarget, email: string, role: string): Promise<string> {
  const wanted = email.trim().toLowerCase()
  const member = (await orgMembers(target)).find((m) => m.email.toLowerCase() === wanted)
  if (member === undefined) {
    throw new Error(
      `No member of this project's organisation has the email "${email}". ` +
        "Invite them first with `supatype admin create-user --email <email> --role <role>`.",
    )
  }
  await targetFetch(target.apiBaseUrl, target.apiPrefix, projectRequest(target, "PATCH", `/studio-members/${member.userId}`, { role }))
  return member.userId
}

/** `create-user` on Cloud: an invitation to the organisation with `role`. */
export async function inviteCloudStudioUser(target: DeployTarget, email: string, role: string, password: string | undefined): Promise<void> {
  if (password !== undefined) {
    throw new Error(
      "--password does not apply to a Supatype Cloud project: the person is invited by email and sets their own password.",
    )
  }
  const path = `/organisations/${orgIdOf(target)}/members`
  await targetFetch(target.apiBaseUrl, target.apiPrefix, apiFetchOpts(target, "POST", path, { email: email.trim().toLowerCase(), role }))
}
