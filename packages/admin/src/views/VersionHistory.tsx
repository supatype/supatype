import React, { useState, useEffect } from "react"
import { Header } from "../components/Header.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import type { ModelConfig } from "../config.js"

interface VersionHistoryProps {
  model: ModelConfig
  recordId: string
  onNavigate: (path: string) => void
}

interface VersionEntry {
  id: string
  version: number
  createdAt: string
  data: Record<string, unknown>
}

export function VersionHistory({ model, recordId, onNavigate }: VersionHistoryProps): React.ReactElement {
  const client = useAdminClient()
  const [versions, setVersions] = useState<VersionEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedVersion, setSelectedVersion] = useState<VersionEntry | null>(null)
  const [currentData, setCurrentData] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        // Version history is stored in {table}_versions
        const versionsTable = `${model.tableName}_versions`
        const result = await client
          .from(versionsTable as never)
          .select()
          .eq("record_id", recordId)
          .order("version", { ascending: false })

        if (result.data) {
          setVersions(result.data as unknown as VersionEntry[])
        }

        // Also fetch current record
        const current = await client
          .from(model.tableName as never)
          .select()
          .eq(model.primaryKey, recordId)
          .single()

        if (current.data) {
          setCurrentData(current.data as Record<string, unknown>)
        }
      } catch {
        // Version table may not exist
      } finally {
        setLoading(false)
      }
    })()
  }, [client, model.tableName, model.primaryKey, recordId])

  const handleRestore = async (version: VersionEntry) => {
    try {
      await client
        .from(model.tableName as never)
        .update(version.data as never)
        .eq(model.primaryKey, recordId)

      onNavigate(`/collections/${model.name}/${recordId}`)
    } catch (err) {
      console.error("Failed to restore version:", err)
    }
  }

  if (loading) {
    return <div className="st-version-history st-edit-loading">Loading...</div>
  }

  return (
    <div className="st-version-history">
      <Header
        title={`Version History — ${model.label}`}
        actions={
          <button
            type="button"
            className="st-btn"
            onClick={() => { onNavigate(`/collections/${model.name}/${recordId}`) }}
          >
            Back to edit
          </button>
        }
      />

      {versions.length === 0 ? (
        <div className="st-version-empty">No version history available.</div>
      ) : (
        <div className="st-version-list">
          {versions.map((version) => (
            <div
              key={version.id}
              className={`st-version-entry${selectedVersion?.id === version.id ? " st-version-entry--selected" : ""}`}
              onClick={() => { setSelectedVersion(version) }}
            >
              <div className="st-version-info">
                <span className="st-version-number">v{version.version}</span>
                <span className="st-version-date">
                  {new Date(version.createdAt).toLocaleString()}
                </span>
              </div>
              <button
                type="button"
                className="st-btn st-btn-sm"
                onClick={(e) => { e.stopPropagation(); void handleRestore(version) }}
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      )}

      {selectedVersion && currentData && (
        <div className="st-version-diff">
          <h3>Changes in v{selectedVersion.version}</h3>
          <table className="st-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Current</th>
                <th>This version</th>
              </tr>
            </thead>
            <tbody>
              {model.fields.map((field) => {
                const current = currentData[field.name]
                const versioned = selectedVersion.data[field.name]
                const changed = JSON.stringify(current) !== JSON.stringify(versioned)

                return (
                  <tr key={field.name} className={changed ? "st-diff-changed" : ""}>
                    <td>{field.label}</td>
                    <td className="st-diff-value">{formatValue(current)}</td>
                    <td className="st-diff-value">{formatValue(versioned)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "object") return JSON.stringify(value).slice(0, 100)
  return String(value)
}
