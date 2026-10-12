import pg from "pg"
import { databaseUrlFromEnv } from "./engine-runner.js"

/**
 * Rows in the project's `_supatype.studio_audit`, the trail the server's Studio membership changes
 * and elevated requests already write to, so one table answers "who did what from Studio".
 *
 * Never a payload: what is recorded is who, what and how big.
 */

export interface AuditEntry {
  /** The Studio user's id, or null when there is none or it is not a uuid the table can hold. */
  actorId: string | null
  action: string
  detail: Record<string, unknown>
}

export interface AuditWriter {
  record(entry: AuditEntry): Promise<void>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The actor as the table's uuid column can take it. */
export function auditActor(actor: string | null): string | null {
  return actor !== null && UUID.test(actor) ? actor : null
}

/** Writes through one small pool on the owner connection the control plane already has. */
class DatabaseAuditWriter implements AuditWriter {
  private pool: pg.Pool | null = null

  async record(entry: AuditEntry): Promise<void> {
    this.pool ??= new pg.Pool({ connectionString: databaseUrlFromEnv(), max: 2 })
    await this.pool.query(
      `INSERT INTO _supatype.studio_audit (actor_id, target_id, action, detail)
       VALUES ($1::uuid, NULL, $2, $3::jsonb)`,
      [entry.actorId, entry.action, JSON.stringify(entry.detail)],
    )
  }
}

let writer: AuditWriter = new DatabaseAuditWriter()

/** Replace the writer, for tests. */
export function setAuditWriter(next: AuditWriter): void {
  writer = next
}

/**
 * Record one entry. A failure is logged loudly and does not fail the request: refusing a test
 * broadcast because the audit table is missing would be the worse outcome, and the server's own
 * elevated-request row for the same call remains.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await writer.record(entry)
  } catch (err) {
    console.error(
      `[control-plane] ${entry.action} by ${entry.actorId ?? "unknown"} not audited:`,
      err instanceof Error ? err.message : err,
    )
  }
}
