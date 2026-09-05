import React, { useCallback, useEffect, useState } from "react"
import { Badge, Button, Card } from "./ui.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useLocale } from "../hooks/useLocale.js"
import type { ModelConfig } from "../config.js"
import {
  fetchVersions,
  publish,
  publishableLocales,
  publishingState,
  unpublish,
  WHOLE_RECORD,
  type LocaleState,
} from "../lib/publishing.js"

interface PublishBarProps {
  model: ModelConfig
  recordId: string
  /** Changes when the record is saved, so the bar re-reads what it summarises. */
  savedAt: number
  onNavigate: (path: string) => void
}

/**
 * What the world currently sees, and the controls to change it.
 *
 * **A record no longer has one publish state.** It has one per locale, because publishing merges a
 * locale's keys into the live row and leaves the rest untouched, so an unpublished translation is
 * genuinely absent from what the world reads rather than hidden behind a rule. A single
 * "Published / Draft" badge cannot say that, and a bar that pretended it could would be lying
 * about the thing an editor most needs to know.
 *
 * A model with no localized field publishes as a whole, and renders as one row rather than as a
 * degenerate list: the machinery is the same underneath, and the interface should not make someone
 * with no translations look at a locale column.
 */
export function PublishBar({
  model,
  recordId,
  savedAt,
  onNavigate,
}: PublishBarProps): React.ReactElement | null {
  const client = useAdminClient()
  const { locales: projectLocales } = useLocale()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<ReturnType<typeof publishingState> | null>(null)

  const locales =
    model.versions === null
      ? [WHOLE_RECORD]
      : publishableLocales(
          model.versions,
          projectLocales.map((l) => l.code),
        )

  const reload = useCallback(async () => {
    const versions = await fetchVersions(client, model, recordId)
    setState(publishingState(versions, locales))
    // `locales` is derived from props that are already dependencies; listing it would rebuild this
    // on every render because the array is new each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, model, recordId, savedAt])

  useEffect(() => {
    void reload()
  }, [reload])

  if (model.versions === null || !model.versions.drafts) return null

  const run = async (act: () => Promise<{ error: string | null }>) => {
    setBusy(true)
    setError(null)
    const result = await act()
    if (result.error !== null) setError(result.error)
    else await reload()
    setBusy(false)
  }

  const wholeRecord = locales.length === 1 && locales[0] === WHOLE_RECORD
  const pending = locales.filter((l) => state?.locales[l] !== "live")

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
            disabled={busy || pending.length === 0}
            onClick={() => {
              void run(() => publish(client, model, recordId))
            }}
          >
            {wholeRecord ? "Publish" : `Publish ${pending.length || "all"}`}
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
            busy={busy}
            onPublish={() => {
              void run(() => publish(client, model, recordId, { locales: [locale] }))
            }}
            onUnpublish={() => {
              void run(() => unpublish(client, model, recordId, [locale]))
            }}
          />
        ))}
      </div>
    </Card>
  )
}

const stateLabels: Record<LocaleState, { label: string; variant: "green" | "yellow" | "blue" | "indigo" }> = {
  live: { label: "Live", variant: "green" },
  pending: { label: "Edit waiting", variant: "yellow" },
  scheduled: { label: "Scheduled", variant: "blue" },
  absent: { label: "Not published", variant: "indigo" },
}

function LocaleRow({
  label,
  state,
  busy,
  onPublish,
  onUnpublish,
}: {
  label: string
  state: LocaleState
  busy: boolean
  onPublish: () => void
  onUnpublish: () => void
}): React.ReactElement {
  const badge = stateLabels[state]
  return (
    <div className="flex items-center justify-between gap-3 py-2">
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
  )
}
