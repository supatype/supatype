import React, { useState, useEffect, useCallback, useRef } from "react"
import { Header } from "../components/Header.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useLocale } from "../hooks/useLocale.js"
import { FieldWidget } from "../widgets/FieldWidget.js"
import { LivePreviewPane } from "../components/LivePreviewPane.js"
import type { ModelConfig, FieldConfig } from "../config.js"
import { useAdminConfig } from "../hooks/useAdminConfig.js"

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
  const [initialValues, setInitialValues] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(!!recordId)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isDirty = useRef(false)

  const isCreate = recordId === undefined

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
          setInitialValues(data)
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
        const result = await client
          .from(model.tableName as never)
          .insert(values as never)

        if (result.error) {
          setError(result.error.message)
        } else if (result.data) {
          const rows = result.data as Record<string, unknown>[]
          const data = rows[0]
          const newId = data ? String(data[model.primaryKey]) : undefined
          if (!newId) { setError("No data returned"); setSaving(false); return }
          isDirty.current = false
          onNavigate(`/collections/${model.name}/${newId}`)
        }
      } else {
        const result = await client
          .from(model.tableName as never)
          .update(values as never)
          .eq(model.primaryKey, recordId!)

        if (result.error) {
          setError(result.error.message)
        } else {
          isDirty.current = false
          setInitialValues(values)
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

      onNavigate(`/collections/${model.name}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  const handleDuplicate = async () => {
    if (!recordId) return
    const duplicateValues = { ...values }
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
        if (data) onNavigate(`/collections/${model.name}/${String(data[model.primaryKey])}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to duplicate")
    }
  }

  const visibleFields = model.fields
    .filter((f) => !f.hidden)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  const livePreviewConfig = config.livePreview?.[model.name]

  if (loading) {
    return <div className="st-edit-view st-edit-loading">Loading...</div>
  }

  return (
    <div className={`st-edit-view${livePreviewConfig ? " st-edit-view--with-preview" : ""}`}>
      <Header
        title={isCreate ? `Create ${model.label}` : `Edit ${model.label}`}
        actions={
          <div className="st-edit-actions">
            {!isCreate && (
              <>
                <button type="button" className="st-btn" onClick={() => { void handleDuplicate() }}>
                  Duplicate
                </button>
                <button type="button" className="st-btn st-btn-danger" onClick={() => { void handleDelete() }}>
                  Delete
                </button>
              </>
            )}
            <button
              type="button"
              className="st-btn st-btn-primary"
              onClick={() => { void handleSave() }}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        }
      />

      {model.hasHooks && (
        <div className="st-hook-indicator">
          This {model.label.toLowerCase()} has custom logic that runs on save.
        </div>
      )}

      {error && <div className="st-error" role="alert">{error}</div>}

      <div className="st-edit-content">
        <form className="st-edit-form" onSubmit={(e) => { e.preventDefault(); void handleSave() }}>
          {visibleFields.map((fieldConfig) => (
            <FieldWidget
              key={`${fieldConfig.name}-${currentLocale}`}
              config={fieldConfig}
              value={getLocalizedValue(values, fieldConfig, currentLocale, defaultLocale)}
              onChange={(val) => {
                if (fieldConfig.localized) {
                  const existing = (values[fieldConfig.name] ?? {}) as Record<string, unknown>
                  handleChange(fieldConfig.name, { ...existing, [currentLocale]: val })
                } else {
                  handleChange(fieldConfig.name, val)
                }
              }}
              readOnly={fieldConfig.readOnly ?? false}
            />
          ))}
        </form>

        {livePreviewConfig && (
          <LivePreviewPane config={livePreviewConfig} values={values} model={model} />
        )}
      </div>
    </div>
  )
}

function getLocalizedValue(
  values: Record<string, unknown>,
  field: FieldConfig,
  currentLocale: string,
  defaultLocale: string,
): unknown {
  const raw = values[field.name]
  if (!field.localized || typeof raw !== "object" || raw === null) return raw
  const locMap = raw as Record<string, unknown>
  return locMap[currentLocale] ?? locMap[defaultLocale] ?? null
}
