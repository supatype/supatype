import React, { useState, useEffect, useCallback } from "react"
import { formatTimestamp } from "../lib/utils.js"
import { Header } from "../components/Header.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { Badge, Button, Card, Td, Th } from "../components/ui.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useLocale } from "../hooks/useLocale.js"
import type { ModelConfig } from "../config.js"
import { useShowsProjectRows } from "../components/ElevatedModeBanner.js"
import {
  fetchVersions,
  publish,
  publishableLocales,
  publishingState,
  restoreVersion,
  WHOLE_RECORD,
  type RecordVersion,
} from "../lib/publishing.js"

interface VersionHistoryProps {
  model: ModelConfig
  recordId: string
  onNavigate: (path: string) => void
}

/**
 * A record's history, and what can be done with it.
 *
 * This view existed before anything wrote a version: it read `{table}_versions` with the right
 * column names, swallowed the error when the table was absent — which it always was, because
 * nothing created it — and restored by `PATCH`ing the live table, which is the one thing restoring
 * must not do. It now reads real rows, and the two acts it offers are the generated functions.
 *
 * **Restore brings a version back as a draft.** Nothing goes live without publishing, so restoring
 * is an editing act with a preview and a second decision behind it. **Publish this version** is the
 * same act followed by that decision, spent behind one button: the two calls are a database contract
 * and an editor should not have to know about them.
 */
export function VersionHistory({
  model,
  recordId,
  onNavigate,
}: VersionHistoryProps): React.ReactElement {
  // Rows here are read with the service role, so the elevated-access notice applies
  // to this view. See `useShowsProjectRows`.
  useShowsProjectRows()

  const client = useAdminClient()
  const { locales: projectLocales } = useLocale()
  const [versions, setVersions] = useState<RecordVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<RecordVersion | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setVersions(await fetchVersions(client, model, recordId))
    setLoading(false)
  }, [client, model, recordId])

  useEffect(() => {
    void reload()
  }, [reload])

  const locales =
    model.versions === null
      ? [WHOLE_RECORD]
      : publishableLocales(model.versions, projectLocales.map((l) => l.code))
  const state = publishingState(versions, locales)

  const run = async (version: number, act: () => Promise<{ error: string | null }>) => {
    setBusy(version)
    setError(null)
    const result = await act()
    if (result.error !== null) {
      setError(result.error)
    } else {
      await reload()
    }
    setBusy(null)
  }

  if (model.versions === null) {
    return (
      <div className="p-6">
        <Header title={`Version history: ${model.label}`} />
        <EmptyState
          title="This model does not keep versions"
          description={`Add \`versions\` to ${model.name} in your schema and push to record a history.`}
        />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-4">
      <Header
        title={`Version history: ${model.label}`}
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              onNavigate(`/models/${model.name}/${recordId}`)
            }}
          >
            Back to edit
          </Button>
        }
      />

      {error !== null && <ErrorBanner message={error} onRetry={() => { void reload() }} />}

      {loading ? (
        <Card className="p-6 text-sm text-muted-foreground">Loading history…</Card>
      ) : versions.length === 0 ? (
        <EmptyState
          title="No versions yet"
          description="A version is recorded the first time this record is saved."
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-border">
              <tr>
                <Th>Version</Th>
                <Th>State</Th>
                <Th>Saved</Th>
                <Th>By</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {versions.map((version) => (
                <tr
                  key={version.id}
                  className={selected?.id === version.id ? "bg-accent/50" : undefined}
                  onClick={() => { setSelected(version) }}
                >
                  <Td className="font-mono">v{version.version}</Td>
                  <Td>
                    <VersionState version={version} newest={state.newest} locales={locales} />
                  </Td>
                  {/* `created_at`, not `createdAt`. PostgREST returns column names as they are and
                      nothing camel-cases them on the way through; this view read the camel form
                      for as long as it existed and rendered "Invalid Date" for every row. */}
                  <Td className="text-muted-foreground">{formatTimestamp(version.created_at)}</Td>
                  <Td className="text-muted-foreground font-mono text-xs">
                    {version.created_by ?? "—"}
                  </Td>
                  <Td className="text-right space-x-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={(e) => {
                        e.stopPropagation()
                        void run(version.version, () =>
                          restoreVersion(client, model, recordId, version.version),
                        )
                      }}
                    >
                      Restore as draft
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={(e) => {
                        e.stopPropagation()
                        void run(version.version, () =>
                          publish(client, model, recordId, { version: version.version }),
                        )
                      }}
                    >
                      Publish this version
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {selected !== null && state.newest !== null && (
        <VersionDiff model={model} version={selected} against={state.newest} />
      )}
    </div>
  )
}

/**
 * What this version is, in one or two badges.
 *
 * A version is live for the locales it claims, and "current" when it is the newest, which is what a
 * draft read and the next publish both work from. Both can be true at once, and neither implies the
 * other: an older version can be live while a newer draft waits.
 */
function VersionState({
  version,
  newest,
  locales,
}: {
  version: RecordVersion
  newest: RecordVersion | null
  locales: string[]
}): React.ReactElement {
  const live = Object.keys(version.published_locales)
  const scheduled = Object.keys(version.scheduled_locales)
  const wholeRecord = locales.length === 1 && locales[0] === WHOLE_RECORD

  return (
    <span className="space-x-1">
      {live.length > 0 && (
        <Badge variant="green">
          {wholeRecord ? "Live" : `Live: ${live.join(", ")}`}
        </Badge>
      )}
      {scheduled.length > 0 && (
        <Badge variant="blue">
          {wholeRecord ? "Scheduled" : `Scheduled: ${scheduled.join(", ")}`}
        </Badge>
      )}
      {version.id === newest?.id && live.length === 0 && (
        <Badge variant="yellow">Pending draft</Badge>
      )}
      {live.length === 0 && scheduled.length === 0 && version.id !== newest?.id && (
        <Badge variant="indigo">Superseded</Badge>
      )}
    </span>
  )
}

/**
 * What changed between this version and the newest.
 *
 * Compared against the newest rather than against the live row, because the live row is not a
 * version: on a record with a pending edit it is neither what you are looking at nor what you would
 * get by restoring, and a diff against it would answer a question nobody asked.
 */
function VersionDiff({
  model,
  version,
  against,
}: {
  model: ModelConfig
  version: RecordVersion
  against: RecordVersion
}): React.ReactElement {
  return (
    <Card className="overflow-x-auto">
      <div className="px-3 py-2 border-b border-border text-sm font-medium">
        v{version.version} compared with the newest, v{against.version}
      </div>
      <table className="w-full">
        <thead className="border-b border-border">
          <tr>
            <Th>Field</Th>
            <Th>v{version.version}</Th>
            <Th>v{against.version}</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {model.fields.map((field) => {
            const mine = version.data[field.name]
            const theirs = against.data[field.name]
            const changed = JSON.stringify(mine) !== JSON.stringify(theirs)
            return (
              <tr key={field.name} className={changed ? "bg-yellow-500/5" : undefined}>
                <Td className="text-muted-foreground">{field.label}</Td>
                <Td className="font-mono text-xs">{formatValue(mine)}</Td>
                <Td className="font-mono text-xs">{formatValue(theirs)}</Td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "object") return JSON.stringify(value).slice(0, 120)
  return String(value)
}
