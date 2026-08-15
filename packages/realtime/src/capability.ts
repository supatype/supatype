/**
 * Whether this database can support realtime at all.
 *
 * Distinct from the transient/fatal split in `db-retry.ts`. A database that cannot do logical
 * decoding is neither: retrying will never help, and exiting is wrong too, because the rest of the
 * stack is fine and the operator's own database may simply not offer the feature. Cloud SQL does not
 * ship `wal2json`; plenty of managed Postgres will not grant `REPLICATION`; `wal_level` is a restart
 * away on a self-managed server and a support ticket on a hosted one.
 *
 * So realtime starts, says exactly what is missing, and reports itself not ready. Everything else
 * keeps working. `supatype db check` reports the same three conditions before you deploy, and
 * `database.external.realtime: false` turns the service off entirely once you know.
 *
 * The SQLSTATEs are measured against `supatype/postgres`, not recalled:
 *
 * ```
 * wal_level = replica  → 55000  logical decoding requires "wal_level" >= "logical"
 * plugin missing       → 58P01  could not access file "wal2json": No such file or directory
 * role lacks REPLICATION → 42501  permission denied to use replication slots
 * ```
 */

/**
 * Thrown when the database cannot support realtime.
 *
 * Its own type so the caller can tell it apart from a genuine startup failure: one means "this
 * feature is off and here is why", the other means "this process is broken".
 */
export class RealtimeUnsupportedError extends Error {
  constructor(
    readonly reason: UnsupportedReason,
    readonly cause: unknown,
  ) {
    super(`realtime is not supported by this database: ${reason}`)
    this.name = "RealtimeUnsupportedError"
  }
}

export type UnsupportedReason =
  | "wal_level is not logical"
  | "the wal2json output plugin is not installed"
  | "the database role may not use replication slots"

/** SQLSTATEs that mean "this database will never support realtime as configured". */
const UNSUPPORTED_BY_CODE: Record<string, UnsupportedReason> = {
  // object_not_in_prerequisite_state — raised by CheckLogicalDecodingRequirements.
  "55000": "wal_level is not logical",
  // undefined_file — the output plugin's shared library is not on the server.
  "58P01": "the wal2json output plugin is not installed",
  // insufficient_privilege — CheckSlotPermissions; only REPLICATION roles may create a slot.
  "42501": "the database role may not use replication slots",
}

/**
 * The reason realtime cannot run on this database, or undefined if the error is something else.
 *
 * Only call this for failures from slot creation. The same codes mean other things elsewhere — 42501
 * is any privilege failure — and treating a missing table as "realtime unsupported" would hide a
 * genuine bug behind a capability message.
 */
export function unsupportedRealtimeReason(error: unknown): UnsupportedReason | undefined {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === "string" && code in UNSUPPORTED_BY_CODE) {
    return UNSUPPORTED_BY_CODE[code]
  }

  // Some poolers and proxies flatten the error to a message. Narrow patterns only.
  const message = error instanceof Error ? error.message : String(error ?? "")
  if (/wal_level.*>=.*logical|requires .*wal_level/i.test(message)) return "wal_level is not logical"
  if (/could not access file "wal2json"/i.test(message)) {
    return "the wal2json output plugin is not installed"
  }
  if (/permission denied to use replication slots/i.test(message)) {
    return "the database role may not use replication slots"
  }
  return undefined
}
