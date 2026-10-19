import { useState } from "react"
import type { SupatypeClient } from "@supatype/client"
import type { ModelConfig } from "../config.js"
import { useAdminClient } from "./useAdminClient.js"
import { serializeRecordForApi } from "../lib/recordValues.js"
import { describeViolations, validateRecord } from "../lib/validate-record.js"
import { createDraft, createRecord, type RecordError } from "../lib/publishing.js"

/** Where a refused save is reported: the banner, and the input the refusal names. */
export interface SaveReport {
  setError: (message: string | null) => void
  setFieldErrors: (errors: Record<string, string>) => void
}

/** A write's outcome: the record's id, or why it was refused. */
type Written = { id: string; error: null } | { id: null; error: RecordError }

/** The form's values as the API takes them, less the primary key, which no write may set. */
function payload(model: ModelConfig, values: Record<string, unknown>): Record<string, unknown> {
  const { [model.primaryKey]: _pk, ...rest } = serializeRecordForApi(model, values)
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
): Promise<Written> {
  const body = payload(model, values)
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

/** The form's own checks, reported where each belongs; true when the form passes them. */
function passesChecks(model: ModelConfig, values: Record<string, unknown>, report: SaveReport): boolean {
  const violations = validateRecord(model.fields, values, model.constraints ?? [])
  if (violations.length === 0) return true
  report.setError(describeViolations(violations))
  // A violation attributed to one field goes on that input; a cross-field rule has no single input
  // to blame and stays in the banner alone.
  report.setFieldErrors(
    Object.fromEntries(
      violations
        .filter((v) => model.fields.some((f) => f.name === v.field))
        .map((v) => [v.field, v.locale ? `(${v.locale}) ${v.message}` : v.message]),
    ),
  )
  return false
}

/**
 * Saving the form, as one call that answers with the record's id.
 *
 * One call rather than a handler per button because three things save: the form's Save, the
 * panel's Save draft, and Publish, which saves unsaved edits before it publishes them.
 */
export function useRecordPersist(
  model: ModelConfig,
  recordId: string | undefined,
  values: Record<string, unknown>,
  report: SaveReport,
): { saving: boolean; persist: () => Promise<string | null> } {
  const client = useAdminClient()
  const [saving, setSaving] = useState(false)

  const persist = async (): Promise<string | null> => {
    if (!passesChecks(model, values, report)) return null
    setSaving(true)
    report.setError(null)
    report.setFieldErrors({})
    try {
      const written = await write(client, model, recordId, values)
      if (written.error !== null) {
        report.setError(written.error.message)
        // The server names the column when a field validator refuses; that message goes on its input.
        if (written.error.field !== undefined) report.setFieldErrors({ [written.error.field]: written.error.message })
      }
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
