import React, { useState, useEffect, useCallback } from "react"
import { Header } from "../components/Header.js"
import { EditFormLayout } from "../components/EditFormLayout.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useLocale } from "../hooks/useLocale.js"
import type { GlobalConfig } from "../config.js"
import { splitEditFields } from "../lib/edit-field-layout.js"

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

  const primaryKey = "id"
  const timestamps = globalConfig.fields.some((f) => f.name === "created_at")

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

  const { mainFields, metaFields } = splitEditFields(globalConfig.fields, {
    primaryKey,
    isCreate: false,
    timestamps,
  })

  if (loading) {
    return <div className="st-global-edit st-edit-loading">Loading...</div>
  }

  return (
    <div className="st-global-edit">
      <Header title={globalConfig.label} />

      {error && <div className="st-error" role="alert">{error}</div>}

      <EditFormLayout
        mainFields={mainFields}
        metaFields={metaFields}
        values={values}
        onChange={handleChange}
        primaryKey={primaryKey}
        currentLocale={currentLocale}
        defaultLocale={defaultLocale}
        recordSyncKey="global"
        slugFollowSource={false}
        saving={saving}
        onSave={() => { void handleSave() }}
        isCreate={false}
      />
    </div>
  )
}
