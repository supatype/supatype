/**
 * Whether Studio offers the SQL editor (RX1).
 *
 * The editor runs as the project's owning role, so row level security does not apply to it, and it
 * is for owners, admins and developers (`sqlEditor` in the shared role matrix). Editors, billing
 * members and viewers are not offered it: the server refuses their queries. As with the rest of the
 * nav, only what the server has said is hidden: before the capability resolves, and on a host that
 * does not report it, the editor stays, and the server still refuses what it should.
 */
export function sqlEditorOffered(capability: { role: string | null; permissions: Record<string, boolean> }): boolean {
  return capability.role === null || capability.permissions["sqlEditor"] === true
}

/** Where the SQL editor lives in Studio. */
export const SQL_EDITOR_HREF = "/database/sql"
