import React, { useEffect, useState } from "react"
import { Badge, Button, type BadgeVariant } from "./ui.js"
import { IconHistory } from "./icons.js"
import { PublishSplitButton } from "./PublishMenu.js"
import { SharePreview } from "./SharePreview.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useLocale } from "../hooks/useLocale.js"
import { usePublishActions, type PublishActions, type RecordEditor } from "../hooks/usePublishActions.js"
import { formatTimestamp } from "../lib/utils.js"
import { describePanel, type PanelModel, type RecordStatus } from "../lib/publish-panel.js"
import type { ModelConfig } from "../config.js"
import {
  fetchPublishingState,
  publishableLocales,
  WHOLE_RECORD,
  type LocaleState,
  type RecordState,
  type PublishingState,
} from "../lib/publishing.js"

/** The record a publish panel is about. */
export interface PublishingRecord {
  model: ModelConfig
  /** Undefined while the record is being created: the first save or publish creates it. */
  recordId: string | undefined
  /** What the record is called, for the questions the panel asks about it. */
  title: string
  /** Where this record renders, when the project has said. */
  previewUrl?: string | undefined
}

interface PublishBarProps {
  record: PublishingRecord
  editor: RecordEditor
  /**
   * Whether this caller sees other people's unpublished work.
   *
   * Passed in rather than read here: the view resolves it once and hands it down. It has to be
   * asked at all because row level security cannot answer it. Studio's data plane goes through the
   * proxy with the service role, which bypasses policies, so the draft-visibility setting that
   * compiles into them binds the API and not this.
   */
  seesDrafts: boolean
  onNavigate: (path: string) => void
}

/** The locales a model publishes under, from the project's locale codes joined with commas. */
function localesFor(model: ModelConfig, codes: string): string[] {
  if (model.versions === null) return [WHOLE_RECORD]
  return publishableLocales(model.versions, codes === "" ? [] : codes.split(","))
}

/** The record's publishing state, re-read whenever the record is saved or acted on. */
function usePublishingState(model: ModelConfig, recordId: string | undefined, codes: string, savedAt: number): PublishingState | null {
  const client = useAdminClient()
  const [state, setState] = useState<PublishingState | null>(null)
  useEffect(() => {
    if (recordId === undefined) return
    let cancelled = false
    void fetchPublishingState(client, model, recordId, localesFor(model, codes)).then((next) => {
      if (!cancelled) setState(next)
    })
    return () => {
      cancelled = true
    }
  }, [client, model, recordId, codes, savedAt])
  return state
}

/**
 * The record's publishing: its status at the top of the sidebar, Save draft beside Publish, and the
 * rarer acts (schedule, discard, unpublish) in the menu on the Publish button.
 *
 * A record has one state per locale underneath, because publishing merges a locale's keys into the
 * live row. One status badge stands for them all; language rows appear only when the languages
 * differ, which is the only time the badge cannot say it alone.
 */
export function PublishBar({ record, editor, seesDrafts, onNavigate }: PublishBarProps): React.ReactElement | null {
  const { locales: projectLocales } = useLocale()
  const codes = projectLocales.map((l) => l.code).join(",")
  const { model, recordId } = record
  const state = usePublishingState(model, recordId, codes, editor.savedAt)
  const actions = usePublishActions({ model, recordId, state }, editor)

  if (model.versions === null || !model.versions.drafts || !seesDrafts) return null

  const locales = localesFor(model, codes)
  const wholeRecord = locales.length === 1 && locales[0] === WHOLE_RECORD
  const creating = recordId === undefined
  const panel = describePanel({ locales, wholeRecord, state, dirty: editor.dirty, creating })
  const labelOf = (code: string): string => projectLocales.find((l) => l.code === code)?.label ?? code
  const view: PanelView = {
    panel,
    title: record.title,
    locales: locales.map((code) => ({ code, label: labelOf(code), state: state?.locales[code] ?? "absent" })),
    busy: actions.busy || editor.saving,
    saving: editor.saving,
    error: actions.error,
  }
  const toHistory = (): void => {
    if (recordId !== undefined) onNavigate(`/models/${model.name}/${recordId}/versions`)
  }
  return (
    <>
      <PublishPanel view={view} actions={{ ...actions, saveDraft: editor.onSave, viewChanges: toHistory }} />
      {recordId !== undefined && <PublishLinks record={{ ...record, recordId }} onHistory={toHistory} />}
    </>
  )
}

/** What the panel shows, already derived. */
export interface PanelView {
  panel: PanelModel
  title: string
  locales: Array<{ code: string; label: string; state: LocaleState }>
  /** Something is being written: every control waits. */
  busy: boolean
  /** The form itself is saving, which Save draft says. */
  saving: boolean
  error: string | null
}

/** What the panel can do, with the plumbing bound. */
export interface PanelActions extends Omit<PublishActions, "busy" | "error"> {
  saveDraft: () => void
  viewChanges: () => void
}

/**
 * The panel, from state handed in.
 *
 * Split from `PublishBar` so what is on screen is a function of its props: the suites render it
 * in every state without a server behind it.
 */
export function PublishPanel({ view, actions }: { view: PanelView; actions: PanelActions }): React.ReactElement {
  const { panel } = view
  return (
    <section className="st-edit-sidebar-section" aria-label="Publishing">
      <StatusLine panel={panel} />
      {panel.localeRows && <LocaleRows view={view} onPublish={(code) => { actions.publish([code]) }} />}
      {/* Wraps rather than clips: in the 280px sidebar Publish takes its own row under Save draft, and
          on a wider layout the two sit side by side. */}
      <div className="flex flex-wrap items-stretch gap-2">
        <Button size="sm" className="grow justify-center" disabled={view.busy} onClick={actions.saveDraft}>
          {view.saving ? "Saving..." : "Save draft"}
        </Button>
        <PublishSplitButton panel={panel} title={view.title} busy={view.busy} actions={actions} />
      </div>
      {view.error !== null && <div className="text-xs text-destructive" role="alert">{view.error}</div>}
      {panel.note !== null && (
        <p className="text-xs text-muted-foreground">
          {panel.note}
          {panel.viewChanges && (
            <Button variant="ghost" size="xs" className="ml-1 inline-flex" onClick={actions.viewChanges}>
              View changes
            </Button>
          )}
        </p>
      )}
    </section>
  )
}

/** The status badge at the top of the panel, one per record. */
export const statusLabels: Record<RecordStatus, { label: string; variant: BadgeVariant }> = {
  draft: { label: "Draft", variant: "indigo" },
  published: { label: "Published", variant: "green" },
  scheduled: { label: "Scheduled", variant: "blue" },
  partial: { label: "Partly published", variant: "yellow" },
}

/** "Status [Published] [Changed]", and when it went or goes live. */
function StatusLine({ panel }: { panel: PanelModel }): React.ReactElement {
  const status = statusLabels[panel.status]
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <span className="st-edit-sidebar-title">Status</span>
        <Badge variant={status.variant}>{status.label}</Badge>
        {panel.changed && (
          <Badge variant="yellow" title="Edited since it was published">
            Changed
          </Badge>
        )}
      </div>
      {panel.since !== null && (
        <div className="text-xs text-muted-foreground">
          {panel.since.label} {formatTimestamp(panel.since.at)}
        </div>
      )}
    </div>
  )
}

/** One row per language, shown only when the languages are in different states. */
function LocaleRows({ view, onPublish }: { view: PanelView; onPublish: (code: string) => void }): React.ReactElement {
  return (
    <div className="space-y-0.5">
      {view.locales.map(({ code, label, state }) => (
        <div key={code} className="flex items-center gap-1.5 py-0.5">
          <span className="text-xs w-16 truncate" title={label}>{label}</span>
          <Badge variant={stateLabels[state].variant} title={stateLabels[state].title}>
            {stateLabels[state].short}
          </Badge>
          <span className="flex-1" />
          {view.panel.rowPublish && state !== "live" && (
            <Button size="xs" variant="ghost" disabled={view.busy} onClick={() => { onPublish(code) }}>
              Publish {code}
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}

/** Version history and the share link, below the publishing controls. */
function PublishLinks({
  record,
  onHistory,
}: {
  record: PublishingRecord & { recordId: string }
  onHistory: () => void
}): React.ReactElement {
  return (
    <div className="st-edit-sidebar-section">
      <Button variant="ghost" size="sm" aria-label="Version history" onClick={onHistory}>
        <IconHistory />
        History
      </Button>
      <SharePreview
        modelName={record.model.name}
        modelTable={record.model.tableName}
        recordId={record.recordId}
        previewUrl={record.previewUrl}
      />
    </div>
  )
}

/**
 * The one vocabulary for a record's or a locale's state, shared by the list, the panel's language
 * rows and the panel's own badge.
 *
 * "Draft" means never published and nothing else; a published record with an edit waiting is
 * "Changed". The list used "Draft" for the second once, so a post the public was reading was
 * labelled like one nobody had seen.
 */
export const stateLabels: Record<
  RecordState,
  { short: string; long: string; variant: BadgeVariant; title: string }
> = {
  live: { short: "Published", long: "Published", variant: "green", title: "Published and visible to readers" },
  pending: { short: "Changed", long: "Changed", variant: "yellow", title: "Published, with a newer edit not yet live" },
  partial: {
    short: "Partly",
    long: "Partly published",
    variant: "yellow",
    title: "Live in some languages and never published in others",
  },
  scheduled: { short: "Scheduled", long: "Scheduled", variant: "blue", title: "Waiting for its scheduled time" },
  absent: { short: "Draft", long: "Draft", variant: "indigo", title: "Not published" },
}
