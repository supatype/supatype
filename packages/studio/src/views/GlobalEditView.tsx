import React, { useState, useEffect, useCallback } from "react"
import { Header } from "../components/Header.js"
import { EditFormLayout } from "../components/EditFormLayout.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useLocale } from "../hooks/useLocale.js"
import type { GlobalConfig } from "../config.js"
import { readOnlyUnless, splitEditFields } from "../lib/edit-field-layout.js"
import { isJsonObject } from "../lib/json.js"
import { serializeRecordForApi } from "../lib/recordValues.js"
import { clearRefusal, passesChecks, reportRefusal } from "../lib/write-error.js"
import { useShowsProjectRows } from "../components/ElevatedModeBanner.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { useRefusal, type Refusal } from "../hooks/useRefusal.js"
import { useContentWriteOffered } from "../hooks/useContentWriteOffered.js"

interface GlobalEditViewProps {
  global: GlobalConfig
}

/** The global's one row, or an empty form when it has none yet. */
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
        // maybeSingle: no row is an answer, not the 406 a single-object read gets for it.
        const result = await client.from(globalConfig.tableName).select().limit(1).maybeSingle()
        if (result.error) setError(result.error.message)
        else setValues(isJsonObject(result.data) ? result.data : {})
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load")
      } finally {
        setLoading(false)
      }
    })()
  }, [client, globalConfig.tableName, setError])

  return { values, setValues, loading }
}

/** The row's key, or undefined before its first save. */
function rowKey(values: Record<string, unknown>): string | undefined {
  const key = values[PRIMARY_KEY]
  return typeof key === "string" && key !== "" ? key : undefined
}

/**
 * Saving the row: an update of the row there is, and an insert only for the first save. It used to
 * be an upsert every time, which needs INSERT, and a global grants an editor only SELECT and UPDATE,
 * so an editor could not save one (issue 73). A refusal goes under the input it is about where the
 * server's answer allows, the same as the record editor, rather than as the server's raw text.
 */
function useGlobalSave(
  globalConfig: GlobalConfig,
  values: Record<string, unknown>,
  setValues: (row: Record<string, unknown>) => void,
  problems: Refusal,
): { saving: boolean; save: () => Promise<void> } {
  const client = useAdminClient()
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    if (!passesChecks(problems, globalConfig.fields, values)) return
    setSaving(true)
    clearRefusal(problems)
    try {
      const table = client.from(globalConfig.tableName)
      const key = rowKey(values)
      // As the record editor sends a row: blanks as null, slugs filled, relations as their keys.
      const { [PRIMARY_KEY]: _key, ...changes } = serializeRecordForApi(globalConfig, values)
      const result = key === undefined
        ? await table.insert(changes).select().maybeSingle()
        : await table.update(changes).eq(PRIMARY_KEY, key).select().maybeSingle()
      if (result.error) reportRefusal(problems, result.error, globalConfig.fields, values)
      // The created row's key, so the next save updates it rather than inserting a second.
      else if (isJsonObject(result.data)) setValues(result.data)
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
  const problems = useRefusal()
  const { values, setValues, loading } = useGlobalRow(globalConfig, problems.setError)
  const { saving, save } = useGlobalSave(globalConfig, values, setValues, problems)
  const handleChange = useCallback((fieldName: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [fieldName]: value }))
  }, [setValues])
  // A viewer reads the global: every input is read only and no Save is offered.
  const canWrite = useContentWriteOffered()
  // Before the first save there is no row: its key is not a field to fill in.
  const isCreate = rowKey(values) === undefined
  const split = splitEditFields(globalConfig.fields, { primaryKey: PRIMARY_KEY, isCreate, timestamps: hasTimestamps(globalConfig) })

  if (loading) return <div className="st-global-edit st-edit-loading">Loading...</div>

  return (
    <div className="st-global-edit">
      <Header title={globalConfig.label} />
      {problems.error && <ErrorBanner message={problems.error} details={problems.details} />}
      <EditFormLayout
        mainFields={readOnlyUnless(canWrite, split.mainFields)}
        metaFields={readOnlyUnless(canWrite, split.metaFields)}
        values={values}
        onChange={handleChange}
        primaryKey={PRIMARY_KEY}
        currentLocale={currentLocale}
        defaultLocale={defaultLocale}
        recordSyncKey="global"
        slugFollowSource={false}
        saving={saving}
        {...(canWrite && { onSave: () => { void save() } })}
        isCreate={isCreate}
        fieldErrors={problems.fieldErrors}
      />
    </div>
  )
}

const PRIMARY_KEY = "id"

function hasTimestamps(globalConfig: GlobalConfig): boolean {
  return globalConfig.fields.some((f) => f.name === "created_at")
}
