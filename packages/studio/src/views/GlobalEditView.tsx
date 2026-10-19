import React, { useState, useEffect, useCallback } from "react"
import { Header } from "../components/Header.js"
import { EditFormLayout } from "../components/EditFormLayout.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useLocale } from "../hooks/useLocale.js"
import type { GlobalConfig } from "../config.js"
import { splitEditFields } from "../lib/edit-field-layout.js"
import { isJsonObject } from "../lib/json.js"
import { passesChecks, reportRefusal, type RefusalReport } from "../lib/write-error.js"
import { useShowsProjectRows } from "../components/ElevatedModeBanner.js"

interface GlobalEditViewProps {
  global: GlobalConfig
}

/** What went wrong: the banner's line, and the message under each input it is about. */
interface Problems extends RefusalReport {
  error: string | null
  fieldErrors: Record<string, string>
}

function useProblems(): Problems {
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  return { error, fieldErrors, setError, setFieldErrors }
}

/** The global's one row. No row yet (406 from `.single()`) is an empty form, not an error. */
function useGlobalRow(
  globalConfig: GlobalConfig,
  setError: (message: string | null) => void,
): { values: Record<string, unknown>; setValues: React.Dispatch<React.SetStateAction<Record<string, unknown>>>; loading: boolean } {
  const client = useAdminClient()
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        const result = await client.from(globalConfig.tableName).select().limit(1).single()
        if (result.error) {
          if (result.error.status === 406) setValues({})
          else setError(result.error.message)
        } else if (isJsonObject(result.data)) {
          setValues(result.data)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load")
      } finally {
        setLoading(false)
      }
    })()
  }, [client, globalConfig.tableName, setError])

  return { values, setValues, loading }
}

/**
 * Saving the row. A refusal goes under the input it is about where the server's answer allows,
 * the same as the record editor, rather than as the server's raw text in the banner.
 */
function useGlobalSave(
  globalConfig: GlobalConfig,
  values: Record<string, unknown>,
  problems: Problems,
): { saving: boolean; save: () => Promise<void> } {
  const client = useAdminClient()
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    if (!passesChecks(problems, globalConfig.fields, values)) return
    setSaving(true)
    problems.setError(null)
    problems.setFieldErrors({})
    try {
      const result = await client.from(globalConfig.tableName).upsert(values)
      if (result.error) reportRefusal(problems, result.error, globalConfig.fields, values)
    } catch (err) {
      problems.setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }
  return { saving, save }
}

export function GlobalEditView({ global: globalConfig }: GlobalEditViewProps): React.ReactElement {
  // Rows here are read with the service role, so the elevated-access notice applies
  // to this view. See `useShowsProjectRows`.
  useShowsProjectRows()

  const { currentLocale, defaultLocale } = useLocale()
  const problems = useProblems()
  const { values, setValues, loading } = useGlobalRow(globalConfig, problems.setError)
  const { saving, save } = useGlobalSave(globalConfig, values, problems)
  const handleChange = useCallback((fieldName: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [fieldName]: value }))
  }, [setValues])

  if (loading) return <div className="st-global-edit st-edit-loading">Loading...</div>

  return (
    <div className="st-global-edit">
      <Header title={globalConfig.label} />
      {problems.error && <div className="st-error" role="alert">{problems.error}</div>}
      <EditFormLayout
        {...splitEditFields(globalConfig.fields, { primaryKey: PRIMARY_KEY, isCreate: false, timestamps: hasTimestamps(globalConfig) })}
        values={values}
        onChange={handleChange}
        primaryKey={PRIMARY_KEY}
        currentLocale={currentLocale}
        defaultLocale={defaultLocale}
        recordSyncKey="global"
        slugFollowSource={false}
        saving={saving}
        onSave={() => { void save() }}
        isCreate={false}
        fieldErrors={problems.fieldErrors}
      />
    </div>
  )
}

const PRIMARY_KEY = "id"

function hasTimestamps(globalConfig: GlobalConfig): boolean {
  return globalConfig.fields.some((f) => f.name === "created_at")
}
