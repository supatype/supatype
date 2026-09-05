import React, { useCallback, useEffect, useState } from "react"
import { Badge, Button, Card } from "./ui.js"
import { ScheduleControl } from "./ScheduleControl.js"
import { SharePreview } from "./SharePreview.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useLocale } from "../hooks/useLocale.js"
import type { ModelConfig } from "../config.js"
import {
  fetchVersions,
  publish,
  publishableLocales,
  publishingState,
  schedulePublish,
  unpublish,
  unschedulePublish,
  WHOLE_RECORD,
  type LocaleState,
  type PublishingState,
} from "../lib/publishing.js"

interface PublishBarProps {
  model: ModelConfig
  recordId: string
  /** Changes when the record is saved, so the bar re-reads what it summarises. */
  savedAt: number
  /** Where this record renders, when the project has said. */
  previewUrl?: string | undefined
  onNavigate: (path: string) => void
}

/**
 * What the world currently sees, and the controls to change it.
 *
 * **A record no longer has one publish state.** It has one per locale, because publishing merges a
 * locale's keys into the live row and leaves the rest untouched, so an unpublished translation is
 * genuinely absent from what the world reads rather than hidden behind a rule. A single
 * "Published / Draft" badge cannot say that, and a bar that pretended it could would be lying about
 * the thing an editor most needs to know.
 *
 * A model with no localized field publishes as a whole and renders as one row rather than as a
 * degenerate list: the machinery is the same underneath, and the interface should not make someone
 * with no translations read a locale column.
 */
export function PublishBar({
  model,
  recordId,
  savedAt,
  previewUrl,
  onNavigate,
}: PublishBarProps): React.ReactElement | null {
  const client = useAdminClient()
  const { locales: projectLocales } = useLocale()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<PublishingState | null>(null)

  const localeCodes = projectLocales.map((l) => l.code).join(",")

  const reload = useCallback(async () => {
    const versions = await fetchVersions(client, model, recordId)
    const locales =
      model.versions === null
        ? [WHOLE_RECORD]
        : publishableLocales(model.versions, localeCodes === "" ? [] : localeCodes.split(","))
    setState(publishingState(versions, locales))
  }, [client, model, recordId, localeCodes, savedAt])

  useEffect(() => {
    void reload()
  }, [reload])

  if (model.versions === null || !model.versions.drafts) return null

  const locales = publishableLocales(
    model.versions,
    localeCodes === "" ? [] : localeCodes.split(","),
  )
  const wholeRecord = locales.length === 1 && locales[0] === WHOLE_RECORD
  const unpublished = locales.filter((l) => state?.locales[l] !== "live")

  const run = async (act: () => Promise<{ error: string | null }>) => {
    setBusy(true)
    setError(null)
    const result = await act()
    if (result.error !== null) setError(result.error)
    else await reload()
    setBusy(false)
  }

  return (
    <Card className="p-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium">Publishing</div>
        <div className="space-x-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onNavigate(`/models/${model.name}/${recordId}/versions`)
            }}
          >
            History
          </Button>
          <Button
            size="sm"
            disabled={busy || unpublished.length === 0}
            onClick={() => {
              void run(() => publish(client, model, recordId))
            }}
          >
            {wholeRecord ? "Publish" : `Publish ${String(unpublished.length)} pending`}
          </Button>
        </div>
      </div>

      {error !== null && <div className="text-xs text-destructive">{error}</div>}

      <div className="divide-y divide-border">
        {locales.map((locale) => (
          <LocaleRow
            key={locale}
            label={wholeRecord ? "This record" : locale}
            state={state?.locales[locale] ?? "absent"}
            scheduledFor={state?.newest?.scheduled_locales[locale] ?? null}
            busy={busy}
            onPublish={() => {
              void run(() => publish(client, model, recordId, { locales: [locale] }))
            }}
            onUnpublish={() => {
              void run(() => unpublish(client, model, recordId, [locale]))
            }}
            onSchedule={(at) => {
              void run(() => schedulePublish(client, model, recordId, at, { locales: [locale] }))
            }}
            onCancelSchedule={() => {
              void run(() => unschedulePublish(client, model, recordId, { locales: [locale] }))
            }}
          />
        ))}
      </div>

      <div className="pt-1 border-t border-border">
        <SharePreview
          modelTable={model.tableName}
          recordId={recordId}
          previewUrl={previewUrl}
        />
      </div>
    </Card>
  )
}

const stateLabels: Record<
  LocaleState,
  { label: string; variant: "green" | "yellow" | "blue" | "indigo" }
> = {
  live: { label: "Live", variant: "green" },
  pending: { label: "Edit waiting", variant: "yellow" },
  scheduled: { label: "Scheduled", variant: "blue" },
  absent: { label: "Not published", variant: "indigo" },
}

function LocaleRow({
  label,
  state,
  scheduledFor,
  busy,
  onPublish,
  onUnpublish,
  onSchedule,
  onCancelSchedule,
}: {
  label: string
  state: LocaleState
  scheduledFor: string | null
  busy: boolean
  onPublish: () => void
  onUnpublish: () => void
  onSchedule: (at: Date) => void
  onCancelSchedule: () => void
}): React.ReactElement {
  const badge = stateLabels[state]
  return (
    <div className="py-2 space-y-1">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm">{label}</span>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        <div className="space-x-2">
          {state !== "live" && (
            <Button size="xs" variant="secondary" disabled={busy} onClick={onPublish}>
              Publish
            </Button>
          )}
          {state !== "absent" && (
            <Button size="xs" variant="ghost" disabled={busy} onClick={onUnpublish}>
              Unpublish
            </Button>
          )}
        </div>
      </div>
      {/* Only where there is something to schedule: a locale already showing the newest version has
          nothing waiting, and offering a date for it would promise to publish something twice. */}
      {state !== "live" && (
        <ScheduleControl
          scheduledFor={scheduledFor}
          busy={busy}
          onSchedule={onSchedule}
          onCancel={onCancelSchedule}
        />
      )}
    </div>
  )
}
