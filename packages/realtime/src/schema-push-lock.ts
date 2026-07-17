/**
 * Advisory lock keys for schema push ↔ realtime decode coordination.
 * Must stay in sync with packages/cli/src/schema-push-lock.ts and
 * supatype-schema-engine (pg_advisory_xact_lock on the same keys).
 */

import type pg from "pg"

export const SCHEMA_PUSH_LOCK_CLASSID = 872014
export const SCHEMA_PUSH_LOCK_OBJID = 1

/** True when a schema push holds the shared advisory lock. */
export async function isSchemaPushLockHeld(client: pg.Client): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory'
         AND classid = $1
         AND objid = $2
         AND granted
     ) AS locked`,
    [SCHEMA_PUSH_LOCK_CLASSID, SCHEMA_PUSH_LOCK_OBJID],
  )
  return result.rows[0]?.locked === true
}
