import React, { useState, useEffect, useCallback, useRef } from "react"
import { Header } from "../components/Header.js"
import { EditFormLayout } from "../components/EditFormLayout.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useLocale } from "../hooks/useLocale.js"
import { LivePreviewPane } from "../components/LivePreviewPane.js"
import type { ModelConfig } from "../config.js"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import { splitEditFields } from "../lib/edit-field-layout.js"
import { serializeRecordForApi } from "../lib/recordValues.js"

interface EditViewProps {
  model: ModelConfig
  recordId?: string
  onNavigate: (path: string) => void
}

export function EditView({ model, recordId, onNavigate }: EditViewProps): React.ReactElement {
  const client = useAdminClient()
  const config = useAdminConfig()
  const { currentLocale, defaultLocale } = useLocale()
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(!!recordId)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isDirty = useRef(false)
  const createTimestampDefaultsApplied = useRef(false)

  const isCreate = recordId === undefined

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
          next[f.name] = new Date().toISOString()
        }
      }
      return next
    })
  }, [recordId, model.fields, model.primaryKey])

  useEffect(() => {
    if (!recordId) return
    setLoading(true)
    void (async () => {
      try {
        const result = await client
          .from(model.tableName as never)
          .select()
          .eq(model.primaryKey, recordId)
          .single()

        if (result.error) {
          setError(result.error.message)
        } else if (result.data) {
          const data = result.data as Record<string, unknown>
          setValues(data)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load record")
      } finally {
        setLoading(false)
      }
    })()
  }, [client, model.tableName, model.primaryKey, recordId])

  const handleChange = useCallback((fieldName: string, value: unknown) => {
    isDirty.current = true
    setValues((prev) => ({ ...prev, [fieldName]: value }))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      if (isCreate) {
        const { [model.primaryKey]: _pk, ...insertValues } = serializeRecordForApi(model, values)
        const result = await client
          .from(model.tableName as never)
          .insert(insertValues as never)

        if (result.error) {
          setError(result.error.message)
        } else if (result.data) {
          const rows = result.data as Record<string, unknown>[]
          const data = rows[0]
          const newId = data ? String(data[model.primaryKey]) : undefined
          if (!newId) { setError("No data returned"); setSaving(false); return }
          isDirty.current = false
          onNavigate(`/models/${model.name}/${newId}`)
        }
      } else {
        const { [model.primaryKey]: _pk, ...updateValues } = serializeRecordForApi(model, values)
        const result = await client
          .from(model.tableName as never)
          .update(updateValues as never)
          .eq(model.primaryKey, recordId!)

        if (result.error) {
          setError(result.error.message)
        } else {
          isDirty.current = false
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!recordId) return
    const confirmed = typeof window !== "undefined" && window.confirm(`Delete this ${model.label}?`)
    if (!confirmed) return

    try {
      await client
        .from(model.tableName as never)
        .delete()
        .eq(model.primaryKey, recordId)

      onNavigate(`/models/${model.name}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  const handleDuplicate = async () => {
    if (!recordId) return
    const duplicateValues = serializeRecordForApi(model, { ...values })
    delete duplicateValues[model.primaryKey]
    delete duplicateValues["created_at"]
    delete duplicateValues["updated_at"]

    try {
      const result = await client
        .from(model.tableName as never)
        .insert(duplicateValues as never)

      if (result.error) {
        setError(result.error.message)
      } else if (result.data) {
        const rows = result.data as Record<string, unknown>[]
        const data = rows[0]
        if (data) onNavigate(`/models/${model.name}/${String(data[model.primaryKey])}`)
      }
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

  const livePreviewConfig = config.livePreview?.[model.name]

  if (loading) {
    return <div className="st-edit-view st-edit-loading">Loading...</div>
  }

  return (
    <div className={`st-edit-view${livePreviewConfig ? " st-edit-view--with-preview" : ""}`}>
      <Header title={isCreate ? `Create ${model.label}` : `Edit ${model.label}`} />

      {model.hasHooks && (
        <div className="st-hook-indicator">
          This {model.label.toLowerCase()} has custom logic that runs on save.
        </div>
      )}

      {error && <div className="st-error" role="alert">{error}</div>}

      <EditFormLayout
        mainFields={mainFields}
        metaFields={metaFields}
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
        {...(!isCreate && {
          onDuplicate: () => { void handleDuplicate() },
          onDelete: () => { void handleDelete() },
        })}
        preview={
          livePreviewConfig ? (
            <LivePreviewPane config={livePreviewConfig} values={values} model={model} />
          ) : undefined
        }
      />
    </div>
  )
}
