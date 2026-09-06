import React, { useCallback, useEffect, useState } from "react"
import { Badge, Button, type BadgeVariant } from "./ui.js"
import { IconChevronRight, IconClock, IconEyeOff, IconHistory, IconUpload } from "./icons.js"
import { ScheduleControl } from "./ScheduleControl.js"
import { SharePreview } from "./SharePreview.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useLocale } from "../hooks/useLocale.js"
import { formatTimestamp } from "../lib/utils.js"
import type { ModelConfig } from "../config.js"
import {
  fetchVersions,
  publish,
  publishableLocales,
  publishingState,
  liveLocales,
  publishingSummary,
  schedulePublish,
  unpublish,
  unschedulePublish,
  WHOLE_RECORD,
  type LocaleState,
  type RecordState,
  type PublishingState,
} from "../lib/publishing.js"

interface PublishBarProps {
  model: ModelConfig
  recordId: string
  /** Changes when the record is saved, so the bar re-reads what it summarises. */
  savedAt: number
  /** Where this record renders, when the project has said. */
  previewUrl?: string | undefined
  /**
   * Whether this caller sees other people's unpublished work.
   *
   * Passed in rather than read here, for the reason every other capability in Studio is: the view
   * resolves it once and hands it down, so a component can be rendered and reasoned about without
   * a network round trip deciding whether it exists.
   *
   * It has to be asked at all because row level security cannot answer it. Studio's data plane goes
   * through the proxy with the service role, which bypasses policies, so the draft-visibility
   * setting that compiles into them binds the API and not this. The server answers from the same
   * stored setting, so one source of truth reaches both.
   */
  seesDrafts: boolean
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
 *
 * # Why it collapses, and why the summary is in the header
 *
 * This sits in a 280px sidebar above the record's own metadata. Spelled out, a two-language record
 * took most of the column: a row per locale, each with two worded buttons and a "Schedule instead"
 * beneath. Most visits to a record are not about publishing it.
 *
 * So the header carries the answer and the body carries the controls. Collapsed, it still says
 * whether anything is waiting, which is the question somebody who is not here to publish would have
 * been scanning for anyway.
 */
export function PublishBar({
  model,
  recordId,
  savedAt,
  previewUrl,
  seesDrafts,
  onNavigate,
}: PublishBarProps): React.ReactElement | null {
  const client = useAdminClient()
  const { locales: projectLocales } = useLocale()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<PublishingState | null>(null)
  const [open, setOpen] = useState<boolean | null>(null)

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
  // A project can narrow who sees drafts, and Studio's data plane goes through the proxy with the
  // service role, so no policy stops this component reading them. The server answers from the same
  // stored setting the policies compile in, and this is where that answer binds.
  if (!seesDrafts) return null

  const locales = publishableLocales(
    model.versions,
    localeCodes === "" ? [] : localeCodes.split(","),
  )
  const wholeRecord = locales.length === 1 && locales[0] === WHOLE_RECORD
  const unpublished = locales.filter((l) => state?.locales[l] !== "live")

  // Opens itself when there is something to decide and stays shut when there is not, until somebody
  // says otherwise. `null` is "nobody has said", which is why this is not just a boolean: once a
  // person opens or closes it, their choice outlives the next publish.
  //
  // It waits for `state` before deciding. Judging from the first paint, where nothing has loaded
  // and every locale therefore reads as unpublished, opened the section on every record and then
  // shut it again under the reader when a fully published one answered.
  const expanded = open ?? (state !== null && unpublished.length > 0)
  const headline = stateLabels[publishingSummary(state, locales)]
  const detail = summaryDetail(state, locales, wholeRecord)

  const run = async (act: () => Promise<{ error: string | null }>) => {
    setBusy(true)
    setError(null)
    const result = await act()
    if (result.error !== null) setError(result.error)
    else await reload()
    setBusy(false)
  }

  return (
    <div className="st-edit-sidebar-section">
      <div className="flex items-center gap-1">
        {/* A span, not the heading element: a button may only contain phrasing content, and the
            disclosure is the whole row rather than a control tucked beside a title. */}
        <button
          type="button"
          className="flex flex-1 items-center gap-1.5 text-left"
          aria-expanded={expanded}
          onClick={() => {
            setOpen(!expanded)
          }}
        >
          <span
            className={`text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            <IconChevronRight size={12} />
          </span>
          <span className="st-edit-sidebar-title">Publishing</span>
          {/* The summary is what makes collapsing safe: shut, this row still answers the question. */}
          <Badge variant={headline.variant} title={headline.title}>
            {headline.long}
          </Badge>
          {/* The badge raises the question; this answers it. With two or three languages the
              specifics fit, and "live in some, never in others" is not something a single word can
              say without hiding which. */}
          {detail !== null && (
            <span className="text-[11px] text-muted-foreground truncate">{detail}</span>
          )}
        </button>
        <IconAction
          icon={<IconHistory />}
          verb="Version"
          target="history"
          busy={false}
          onClick={() => {
            onNavigate(`/models/${model.name}/${recordId}/versions`)
          }}
        />
      </div>

      {expanded && (
        <PublishBarBody
          record={{
            modelName: model.name,
            modelTable: model.tableName,
            recordId,
            ...(previewUrl !== undefined && { previewUrl }),
          }}
          view={{ locales, wholeRecord, state, busy, error }}
          actions={{
            publishAll: () => {
              void run(() => publish(client, model, recordId))
            },
            publish: (locale) => {
              void run(() => publish(client, model, recordId, { locales: [locale] }))
            },
            unpublish: (locale) => {
              void run(() => unpublish(client, model, recordId, [locale]))
            },
            schedule: (locale, at) => {
              void run(() => schedulePublish(client, model, recordId, at, { locales: [locale] }))
            },
            cancelSchedule: (locale) => {
              void run(() => unschedulePublish(client, model, recordId, { locales: [locale] }))
            },
          }}
        />
      )}
    </div>
  )
}

/** The record this section is about, and where it renders. */
export interface PublishingRecord {
  /** The model's name, which is the key `admin.livePreview` is written under. */
  modelName: string
  modelTable: string
  recordId: string
  /** Where this record renders, when the project has said. */
  previewUrl?: string | undefined
}

/** What is currently true, as the controls need to know it. */
export interface PublishingView {
  locales: string[]
  /** A model with no localized field publishes as a whole and shows one row, not a locale column. */
  wholeRecord: boolean
  state: PublishingState | null
  busy: boolean
  error: string | null
}

/** What can be done, with the plumbing already bound. */
export interface PublishingActions {
  publishAll: () => void
  publish: (locale: string) => void
  unpublish: (locale: string) => void
  schedule: (locale: string, at: Date) => void
  cancelSchedule: (locale: string) => void
}

/**
 * The controls, once the section is open.
 *
 * Split from `PublishBar` so that what is on screen is a function of what is passed in. The bar
 * itself fetches, holds the disclosure and binds the client; this renders. That is also the only
 * way the states below get tested: the suite renders static markup deliberately, so no effect ever
 * runs and a component that learns its state from one can only ever be seen empty.
 */
export function PublishBarBody({
  record,
  view,
  actions,
}: {
  record: PublishingRecord
  view: PublishingView
  actions: PublishingActions
}): React.ReactElement {
  const pending = view.locales.filter((l) => view.state?.locales[l] !== "live")

  return (
    <>
      <Button
        className="w-full justify-center"
        size="sm"
        disabled={view.busy || pending.length === 0}
        onClick={actions.publishAll}
      >
        {view.wholeRecord ? "Publish" : `Publish ${String(pending.length)} pending`}
      </Button>

      {view.error !== null && <div className="text-xs text-destructive">{view.error}</div>}

      <div className="space-y-0.5">
        {view.locales.map((locale) => (
          <LocaleRow
            key={locale}
            label={view.wholeRecord ? "This record" : locale}
            state={view.state?.locales[locale] ?? "absent"}
            scheduledFor={view.state?.newest?.scheduled_locales[locale] ?? null}
            busy={view.busy}
            onPublish={() => {
              actions.publish(locale)
            }}
            onUnpublish={() => {
              actions.unpublish(locale)
            }}
            onSchedule={(at) => {
              actions.schedule(locale, at)
            }}
            onCancelSchedule={() => {
              actions.cancelSchedule(locale)
            }}
          />
        ))}
      </div>

      <div className="pt-1 border-t border-border">
        <SharePreview
          modelName={record.modelName}
          modelTable={record.modelTable}
          recordId={record.recordId}
          previewUrl={record.previewUrl}
        />
      </div>
    </>
  )
}

/**
 * Which languages the world can read, said plainly beside the badge.
 *
 * Only where it adds something: a model with no localized field has one state and no languages to
 * distinguish, and a record that is uniformly live or uniformly unpublished is fully described by
 * its badge already.
 */
function summaryDetail(
  state: PublishingState | null,
  locales: string[],
  wholeRecord: boolean,
): string | null {
  if (wholeRecord) return null
  const live = liveLocales(state, locales)
  if (live.length === 0 || live.length === locales.length) return null
  const notLive = locales.filter((l) => !live.includes(l))
  return `${live.join(", ")} live · ${notLive.join(", ")} not`
}

/**
 * The one vocabulary, for a locale and for a whole record.
 *
 * Both spellings live here together because the list, the collapsed header and the row underneath
 * it sit within two clicks of each other. They came from separate tables once and used "Draft" for
 * two different things: a record with an unpublished edit in the list, and a locale that had never
 * been published at all in the editor. A post whose English was being read by the public was
 * labelled the same as one nobody had ever seen.
 */
export const stateLabels: Record<
  RecordState,
  { short: string; long: string; variant: BadgeVariant; title: string }
> = {
  live: {
    short: "Live",
    long: "Live",
    variant: "green",
    title: "Published and visible to readers",
  },
  pending: {
    short: "Edit",
    long: "Edit waiting",
    variant: "yellow",
    title: "Published, with a newer edit not yet live",
  },
  partial: {
    short: "Partly",
    long: "Partly published",
    variant: "yellow",
    title: "Live in some languages and never published in others",
  },
  scheduled: {
    short: "Timed",
    long: "Scheduled",
    variant: "blue",
    title: "Waiting for its scheduled time",
  },
  absent: {
    short: "Draft",
    long: "Not published",
    variant: "indigo",
    title: "Not published",
  },
}

/**
 * One glyph, one verb, one handler.
 *
 * The row's three actions differ only in those three things, and writing them out separately meant
 * three call sites each had to remember the tooltip and the label. Making that structural is the
 * point: the icons are here to fit the column, which is a layout decision, and it must not become
 * the only way to know what a control does.
 */
function IconAction({
  icon,
  verb,
  target,
  busy,
  detail,
  onClick,
}: {
  icon: React.ReactNode
  verb: string
  target: string
  busy: boolean
  /** Extra tooltip text, when there is a fact worth stating beyond the verb. */
  detail?: string | undefined
  onClick: () => void
}): React.ReactElement {
  const label = `${verb} ${target}`
  return (
    <Button
      size="icon"
      variant="ghost"
      disabled={busy}
      title={detail === undefined ? label : `${label} (${detail})`}
      aria-label={detail === undefined ? label : `${label}, ${detail}`}
      onClick={onClick}
    >
      {icon}
    </Button>
  )
}

/**
 * One locale, on one line: what it is, and what can be done to it.
 *
 * Actions are glyphs because words for them do not fit beside a locale and a badge in a 280px
 * column, and wrapping them put every language on three lines.
 */
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
  const [scheduling, setScheduling] = useState(false)

  // A locale already showing the newest version has nothing waiting, so there is nothing to publish
  // and nothing to put a time on: offering a date would promise to publish something twice.
  const canPublish = state !== "live"
  const canUnpublish = state !== "absent"
  // A time already set is shown whether or not the picker was asked for. It is a fact about the
  // record, not a control somebody opened.
  const showPicker = canPublish && (scheduling || scheduledFor !== null)

  return (
    <div className="py-0.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs truncate" title={label}>
          {label}
        </span>
        <Badge variant={badge.variant} title={badge.title}>
          {badge.short}
        </Badge>
        <span className="flex-1" />
        {canPublish && (
          <>
            <IconAction
              icon={<IconUpload />}
              verb="Publish"
              target={label}
              busy={busy}
              onClick={onPublish}
            />
            <IconAction
              icon={<IconClock size={14} />}
              verb="Schedule"
              target={label}
              busy={busy}
              {...(scheduledFor !== null && { detail: `set for ${formatTimestamp(scheduledFor)}` })}
              onClick={() => {
                setScheduling(!showPicker)
              }}
            />
          </>
        )}
        {canUnpublish && (
          <IconAction
            icon={<IconEyeOff />}
            verb="Unpublish"
            target={label}
            busy={busy}
            onClick={onUnpublish}
          />
        )}
      </div>

      {showPicker && (
        <div className="pl-1 pt-1">
          <ScheduleControl
            scheduledFor={scheduledFor}
            busy={busy}
            onSchedule={(at) => {
              setScheduling(false)
              onSchedule(at)
            }}
            onCancel={onCancelSchedule}
          />
        </div>
      )}
    </div>
  )
}
