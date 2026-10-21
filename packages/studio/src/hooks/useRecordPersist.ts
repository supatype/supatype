import { useState } from "react"
import type { SupatypeClient } from "@supatype/client"
import type { ModelConfig } from "../config.js"
import { useAdminClient } from "./useAdminClient.js"
import { serializeRecordForApi } from "../lib/recordValues.js"
import { clearRefusal, passesChecks, reportRefusal, type RefusalReport } from "../lib/write-error.js"
import { createDraft, createRecord, type RecordError } from "../lib/publishing.js"

/** A write's outcome: the record's id, or why it was refused. */
type Written = { id: string; error: null } | { id: null; error: RecordError }

/**
 * The form's values as the API takes them, less the primary key, which no write may set, and less
 * the columns this caller may not send for this record (see `lockedColumns`).
 */
function payload(model: ModelConfig, values: Record<string, unknown>, omit: readonly string[]): Record<string, unknown> {
  const { [model.primaryKey]: _pk, ...rest } = serializeRecordForApi(model, values)
  for (const column of omit) delete rest[column]
  return rest
}

/**
 * Write the form: create the record, save a draft of it, or update it in place.
 *
 * On a model with drafts saving records a draft and the live row does not move, so an author can
 * save work in progress on a published record without the world seeing it.
 */
async function write(
  client: SupatypeClient,
  model: ModelConfig,
  recordId: string | undefined,
  values: Record<string, unknown>,
  omit: readonly string[],
): Promise<Written> {
  const body = payload(model, values, omit)
  if (recordId === undefined) {
    const created = await createRecord(client, model, body)
    return created.error === null && created.id !== null
      ? { id: created.id, error: null }
      : { id: null, error: created.error ?? { message: "No data returned" } }
  }
  if (model.versions?.drafts === true) {
    const drafted = await createDraft(client, model, recordId, body)
    return drafted.error === null ? { id: recordId, error: null } : { id: null, error: { message: drafted.error } }
  }
  const result = await client.from(model.tableName).update(body).eq(model.primaryKey, recordId)
  return result.error === null ? { id: recordId, error: null } : { id: null, error: result.error }
}

/**
 * Saving the form, as one call that answers with the record's id.
 *
 * One call rather than a handler per button because three things save: the form's Save, the
 * panel's Save draft, and Publish, which saves unsaved edits before it publishes them.
 *
 * `locked` names the columns the save leaves alone: they are neither sent nor checked, since the
 * caller can neither see nor change them, and a withheld required column would otherwise read as
 * empty and stop every save.
 */
export function useRecordPersist(
  model: ModelConfig,
  recordId: string | undefined,
  values: Record<string, unknown>,
  report: RefusalReport,
  locked: readonly string[] = [],
): { saving: boolean; persist: () => Promise<string | null> } {
  const client = useAdminClient()
  const [saving, setSaving] = useState(false)

  const persist = async (): Promise<string | null> => {
    const checked = model.fields.filter((f) => !locked.includes(f.name))
    if (!passesChecks(report, checked, values, model.constraints ?? [])) return null
    setSaving(true)
    clearRefusal(report)
    try {
      const written = await write(client, model, recordId, values, locked)
      if (written.error !== null) reportRefusal(report, written.error, model.fields, values)
      return written.id
    } catch (err) {
      report.setError(err instanceof Error ? err.message : "Failed to save")
      return null
    } finally {
      setSaving(false)
    }
  }
  return { saving, persist }
}
