import React, { useState, useEffect, useCallback } from "react"
import { Header } from "../components/Header.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useLocale } from "../hooks/useLocale.js"
import { FieldWidget } from "../widgets/FieldWidget.js"
import type { GlobalConfig, FieldConfig } from "../config.js"

interface GlobalEditViewProps {
  global: GlobalConfig
}

export function GlobalEditView({ global: globalConfig }: GlobalEditViewProps): React.ReactElement {
  const client = useAdminClient()
  const { currentLocale, defaultLocale } = useLocale()
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        const result = await client
          .from(globalConfig.tableName as never)
          .select()
          .limit(1)
          .single()

        if (result.error) {
          if (result.error.status === 406) {
            setValues({})
          } else {
            setError(result.error.message)
          }
        } else if (result.data) {
          setValues(result.data as Record<string, unknown>)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load")
      } finally {
        setLoading(false)
      }
    })()
  }, [client, globalConfig.tableName])

  const handleChange = useCallback((fieldName: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [fieldName]: value }))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const result = await client
        .from(globalConfig.tableName as never)
        .upsert(values as never)

      if (result.error) {
        setError(result.error.message)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  const visibleFields = globalConfig.fields.filter((f) => !f.hidden)

  if (loading) {
    return <div className="st-global-edit st-edit-loading">Loading...</div>
  }

  return (
    <div className="st-global-edit">
      <Header
        title={globalConfig.label}
        actions={
          <button
            type="button"
            className="st-btn st-btn-primary"
            onClick={() => { void handleSave() }}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        }
      />

      {error && <div className="st-error" role="alert">{error}</div>}

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
