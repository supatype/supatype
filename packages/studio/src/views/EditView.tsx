import React, { useState, useEffect, useCallback, useRef } from "react"
import { Header } from "../components/Header.js"
import { EditFormLayout } from "../components/EditFormLayout.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useLocale } from "../hooks/useLocale.js"
import { LivePreviewPane } from "../components/LivePreviewPane.js"
import { PublishBar } from "../components/PublishBar.js"
import { Slideover } from "../components/Slideover.js"
import { Button, DestructiveAnswers, Dialog } from "../components/ui.js"
import { previewUrlFor } from "../lib/preview-url.js"
import { appOrigin } from "../lib/membership-url.js"
import type { ModelConfig } from "../config.js"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import { splitEditFields } from "../lib/edit-field-layout.js"
import { applyFieldAccess } from "../lib/field-access-layout.js"
import {
  affordanceColumn,
  isOperationOffered,
  needsPerRecordCheck,
  useStudioFieldAccess,
} from "../hooks/useStudioFieldAccess.js"
import { useStudioCapability } from "../hooks/useStudioCapability.js"
import { getLocalizedFieldValue } from "../lib/localized-field.js"
import { localTimestamp } from "../lib/local-datetime.js"
import { isJsonObject } from "../lib/json.js"
import { useRecordPersist } from "../hooks/useRecordPersist.js"
import { useBooleanStartValues } from "../hooks/useBooleanStartValues.js"
import { useShowsProjectRows } from "../components/ElevatedModeBanner.js"
import { fetchRecordForEditing } from "../lib/publishing.js"
import { duplicateRecord, type RecordDraft } from "../lib/duplicate-record.js"
import { reportRefusal } from "../lib/write-error.js"
import { useRefusal } from "../hooks/useRefusal.js"
import { ErrorBanner } from "../components/ErrorBanner.js"

interface EditViewProps {
  model: ModelConfig
  recordId?: string
  /** A create form's starting values and field messages, such as a copy Duplicate could not save. */
  draft?: RecordDraft | undefined
  onNavigate: (path: string, draft?: RecordDraft) => void
}

export function EditView({ model, recordId, draft, onNavigate }: EditViewProps): React.ReactElement {
  // Rows here are read with the service role, so the elevated-access notice applies
  // to this view. See `useShowsProjectRows`.
  useShowsProjectRows()

  const client = useAdminClient()
  const config = useAdminConfig()
  const { currentLocale, defaultLocale } = useLocale()
  const [values, setValues] = useState<Record<string, unknown>>(draft?.values ?? {})
  const [loading, setLoading] = useState(!!recordId)
  // Field errors are keyed by column. Both sources land there: a bound or constraint Studio checked
  // itself, and the server's refusal, which names the column it refused where it can.
  const refusal = useRefusal(draft?.fieldErrors ?? {})
  const { error, setError, fieldErrors } = refusal
  const [previewOpen, setPreviewOpen] = useState(false)
  // Bumped on every successful save, so the publish bar re-reads the history it summarises. A
  // saved draft changes what that bar should say, and nothing else tells it.
  const [savedAt, setSavedAt] = useState(0)
  // The form holds edits nobody has saved. State rather than a ref: the publish panel says
  // "Changed" and offers to publish them.
  const [dirty, setDirty] = useState(false)
  // Bumped when an act changed the record's values under the form (Discard changes), so it re-reads
  // them without the loading screen a first open shows.
  const [formNonce, setFormNonce] = useState(0)
  const quietReload = useRef(false)
  const createTimestampDefaultsApplied = useRef(false)

  const isCreate = recordId === undefined
  useBooleanStartValues(model, isCreate, setValues)
  const fieldAccess = useStudioFieldAccess()
  const capability = useStudioCapability()
  // null = not asked or not answerable. Only ever set from the database's own answer.
  const [recordDeletable, setRecordDeletable] = useState<boolean | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    if (recordId !== undefined) {
      createTimestampDefaultsApplied.current = false
      return
    }
    if (createTimestampDefaultsApplied.current) return
    createTimestampDefaultsApplied.current = true
    setValues((prev) => {
      let next = prev
      for (const f of model.fields) {
        if (f.hidden || f.readOnly || f.name === model.primaryKey) continue
        const already = prev[f.name]
        if (already !== undefined && already !== null) continue
        if (
          (f.widget === "datetime" || f.widget === "date") &&
          f.options?.["studioTimestampDefault"] === "now"
        ) {
          if (next === prev) next = { ...prev }
          // With the offset, as the date-time widget saves: a column without a zone keeps the
          // editor's wall time rather than UTC's.
          next[f.name] = localTimestamp(new Date())
        }
      }
      return next
    })
  }, [recordId, model.fields, model.primaryKey])

  // Per-record delete affordance, asked only when the table-level verdict is `row`.
  //
  // Deliberately its own query rather than extra columns on the record load: the affordance is
  // not a column of the record, and `serializeRecordForApi` spreads whatever is in `values`
  // straight into the PATCH body, so a computed column merged in there would be sent back as
  // an unknown column and fail every save.
  useEffect(() => {
    if (recordId === undefined) return
    if (!needsPerRecordCheck(fieldAccess, model.tableName, "delete")) {
      setRecordDeletable(null)
      return
    }

    let cancelled = false
    const column = affordanceColumn(model.tableName, "delete")
    void (async () => {
      const result = await client
        .from(model.tableName)
        .select(`${model.primaryKey},${column}`)
        .eq(model.primaryKey, recordId)
        .single()
      if (cancelled) return
      const row: unknown = result.data
      // Fails open: an error or a missing answer leaves the control offered, and the database
      // refuses the delete if it should.
      setRecordDeletable(result.error !== null || !isJsonObject(row) ? null : row[column] === true)
    })()

    return () => {
      cancelled = true
    }
  }, [client, fieldAccess, model.tableName, model.primaryKey, recordId])

  useEffect(() => {
    if (!recordId) return
    if (!quietReload.current) setLoading(true)
    quietReload.current = false
    void (async () => {
      try {
        // The pending draft when the model has one, because that is what an editor is editing.
        // The live row is what the world sees, and opening it would show the author their own
        // unsaved-to-the-world content replaced by what they last published.
        const loaded = await fetchRecordForEditing(client, model, recordId)
        if (loaded.error !== null) {
          setError(loaded.error)
        } else if (loaded.values !== null) {
          setValues(loaded.values)
          setDirty(false)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load record")
      } finally {
        setLoading(false)
      }
    })()
  }, [client, model, recordId, formNonce])

  const { saving, persist } = useRecordPersist(model, recordId, values, refusal)

  const handleChange = useCallback((fieldName: string, value: unknown) => {
    setDirty(true)
    setValues((prev) => ({ ...prev, [fieldName]: value }))
  }, [])

  /**
   * After a write reached the record: a new one opens as itself, an existing one re-reads what
   * summarises it, and the form re-reads its values when the act changed them under it.
   */
  const onChanged = (id: string, reloadForm: boolean): void => {
    if (isCreate) {
      onNavigate(`/models/${model.name}/${id}`)
      return
    }
    setSavedAt(Date.now())
    if (!reloadForm) return
    quietReload.current = true
    setFormNonce((n) => n + 1)
  }

  const persistAndMark = async (): Promise<string | null> => {
    const id = await persist()
    if (id !== null) setDirty(false)
    return id
  }

  const handleSave = async () => {
    const id = await persistAndMark()
    if (id !== null) onChanged(id, false)
  }

  // Asked first, in the same words as Unpublish. A refused delete reports its error and stays on
  // the record: the client resolves a refusal rather than throwing it, so leaving for the list on
  // any answer read as a delete that had worked.
  const handleDelete = async () => {
    if (!recordId) return
    try {
      const { error: refused } = await client.from(model.tableName).delete().eq(model.primaryKey, recordId)
      if (refused) reportRefusal(refusal, refused, model.fields, values)
      else onNavigate(`/models/${model.name}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  const handleDuplicate = async () => {
    if (!recordId) return
    try {
      // A copy of a record with drafts is a new draft too: the form holds the draft's values, and
      // inserting them as the live row put unpublished content live.
      const outcome = await duplicateRecord(client, model, values)
      if (outcome.kind === "created") onNavigate(`/models/${model.name}/${outcome.id}`)
      else if (outcome.kind === "needsInput") onNavigate(`/models/${model.name}/create`, outcome.draft)
      else setError(outcome.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to duplicate")
    }
  }

  const splitCtx = {
    primaryKey: model.primaryKey,
    isCreate,
    timestamps: model.timestamps,
  }
  const { mainFields, metaFields } = splitEditFields(model.fields, splitCtx)

  // Per-column access, applied to the field lists rather than inside the widgets: a column
  // this caller cannot write becomes a disabled input, and one no caller can supply is left
  // out of a create form instead of rendered as an input nobody can satisfy.
  const accessibleMainFields = applyFieldAccess(mainFields, fieldAccess, model.tableName, isCreate)
  const accessibleMetaFields = applyFieldAccess(metaFields, fieldAccess, model.tableName, isCreate)

  const livePreviewConfig = config.livePreview?.[model.name]
  // Where this record renders, or "" when the project named no address for it. Computed once and
  // shared: the pane and the share control must agree, and the pane must not mount without one.
  // `<iframe src="">` resolves against the document's own base, which is Studio, so an entry naming
  // neither a url nor a pattern booted a second copy of Studio inside the edit form.
  const previewUrl =
    livePreviewConfig === undefined
      ? ""
      : previewUrlFor(livePreviewConfig, values, appOrigin(client.url))

  if (loading) {
    return <div className="st-edit-view st-edit-loading">Loading...</div>
  }

  // Publishing lives in the sidebar beside the record's other metadata rather than as a banner
  // above the form. On a model with drafts it holds the form's save as "Save draft", so it is
  // there on a new record too: the first save or publish creates the record.
  //
  // Named once because two things read it. The preview pane has to explain the publish controls'
  // absence, and when the two asked the question separately the pane embedded a preview page whose
  // advice was to use a control that was not on the screen.
  const awaitingFirstSave = isCreate || recordId === undefined
  const title = recordTitle(model, values, currentLocale, defaultLocale)
  const publishing =
    model.versions?.drafts === true && capability.seesDrafts ? (
      <PublishBar
        record={{
          model,
          recordId,
          title,
          ...(previewUrl !== "" && { previewUrl }),
        }}
        editor={{ dirty, saving, savedAt, onSave: () => { void handleSave() }, persist: persistAndMark, onChanged }}
        seesDrafts={capability.seesDrafts}
        onNavigate={onNavigate}
      />
    ) : undefined
  return (
    <div className="st-edit-view">
      <Header title={isCreate ? `Create ${model.label}` : `Edit ${model.label}`} />

      {model.hasHooks && (
        <div className="st-hook-indicator">
          This {model.label.toLowerCase()} has custom logic that runs on save.
        </div>
      )}

      {error && <ErrorBanner message={error} details={refusal.details} />}

      {confirmingDelete && (
        <DeleteQuestion title={title} act={() => { void handleDelete() }} onClose={() => { setConfirmingDelete(false) }} />
      )}

      <EditFormLayout
        {...(publishing !== undefined && { publishing })}
        mainFields={accessibleMainFields}
        metaFields={accessibleMetaFields}
        values={values}
        onChange={handleChange}
        primaryKey={model.primaryKey}
        currentLocale={currentLocale}
        defaultLocale={defaultLocale}
        recordSyncKey={recordId ?? "__create__"}
        slugFollowSource={recordId === undefined}
        saving={saving}
        onSave={() => { void handleSave() }}
        isCreate={isCreate}
        {...(Object.keys(fieldErrors).length > 0 && { fieldErrors })}
        {...(!isCreate && {
          onDuplicate: () => { void handleDuplicate() },
          // Two layers: the table-level verdict withdraws the control where it is settled, and
          // the per-record affordance answers where it is not.
          ...(isOperationOffered(fieldAccess, model.tableName, "delete") &&
            recordDeletable !== false && {
              onDelete: () => { setConfirmingDelete(true) },
            }),
        })}
        previewAction={
          livePreviewConfig !== undefined && previewUrl !== "" ? (
            <Button onClick={() => { setPreviewOpen(true) }}>
              Live preview
            </Button>
          ) : undefined
        }
      />

      {/*
        The preview is a slide-over rather than a second column. It costs the form half its width
        whenever a project configures one, and most of editing is not previewing, so it is opened
        when wanted and out of the way otherwise. Mounted only while open so the iframe is not
        loading a page nobody is looking at.
      */}
      {livePreviewConfig !== undefined && previewUrl !== "" && previewOpen && (
        <Slideover
          open={previewOpen}
          onClose={() => { setPreviewOpen(false) }}
          title={`Preview: ${model.label}`}
        >
          <LivePreviewPane
            previewUrl={previewUrl}
            values={values}
            model={model}
            awaitingFirstSave={awaitingFirstSave}
          />
        </Slideover>
      )}
    </div>
  )
}

/** The question Delete asks, naming the record as Unpublish does. */
function DeleteQuestion({ title, act, onClose }: { title: string; act: () => void; onClose: () => void }): React.ReactElement {
  return (
    <Dialog role="alertdialog" title={`Delete "${title}"?`} actions={<DestructiveAnswers label="Delete" act={act} onClose={onClose} />}>
      <p>It is deleted for good. This cannot be undone.</p>
    </Dialog>
  )
}

/** What the record is called: its first list column's value, or the model's name for it. */
function recordTitle(
  model: ModelConfig,
  values: Record<string, unknown>,
  currentLocale: string,
  defaultLocale: string,
): string {
  const column = model.listColumns[0]
  const field = model.fields.find((f) => f.name === column)
  if (column === undefined || field === undefined) return `this ${model.label.toLowerCase()}`
  const value = getLocalizedFieldValue(values[column], field.localized, currentLocale, defaultLocale)
  return typeof value === "string" && value.trim() !== "" ? value : `this ${model.label.toLowerCase()}`
}