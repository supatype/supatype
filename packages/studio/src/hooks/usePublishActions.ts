import { useState } from "react"
import type { SupatypeClient } from "@supatype/client"
import type { ModelConfig } from "../config.js"
import { useAdminClient } from "./useAdminClient.js"
import {
  publish,
  restoreVersion,
  schedulePublish,
  snapshotLiveRow,
  unpublish,
  unschedulePublish,
  type PublishingState,
} from "../lib/publishing.js"
import { explainRefusal } from "../lib/database-refusal.js"

/** The form a publish panel sits beside, as far as publishing needs it. */
export interface RecordEditor {
  /** The form holds edits nobody has saved. */
  dirty: boolean
  saving: boolean
  /** Changes when the record is saved, so the panel re-reads what it summarises. */
  savedAt: number
  /** A draft was saved from this form and no publishing act has followed it. */
  draftSaved?: boolean
  /** The plain "Save draft": what the form's own save button does. */
  onSave: () => void
  /** Save the form as a draft, creating the record when it is new: its id, or null when refused. */
  persist: () => Promise<string | null>
  /** A publishing act changed record `id`; `reloadForm` when the form must re-read its values. */
  onChanged: (id: string, reloadForm: boolean) => void
}

export interface PublishActions {
  busy: boolean
  error: string | null
  /** Publish every locale, or the ones named. Saves unsaved edits first. */
  publish: (locales?: string[]) => void
  schedule: (at: Date) => void
  cancelSchedule: () => void
  /** Return the draft to the published version, and the form with it. */
  discard: () => void
  /** Withdraw every locale, or the ones named. */
  unpublish: (locales?: string[]) => void
}

type Step = (id: string) => Promise<{ error: string | null }>

/**
 * What an act needs before its steps run: `save` writes unsaved edits (or records a history-less
 * record's live row), `snapshot` only records the live row, `none` acts on the record as it is.
 */
type Prepare = "save" | "snapshot" | "none"

interface Context {
  client: SupatypeClient
  model: ModelConfig
  recordId: string | undefined
  state: PublishingState | null
  editor: RecordEditor
}

/**
 * The record to act on, with a version to act from.
 *
 * Unsaved edits are saved first, as the button says it publishes what is on screen. A record with
 * no history gets its live row recorded as version 1 first: `publish` and `schedule_publish` refuse
 * a record with no version ("Save a draft first"), and `unpublish` on a localized model would strip
 * the only copy of its content.
 */
async function prepare(ctx: Context, mode: Prepare): Promise<{ id: string | null; error: string | null }> {
  if (ctx.recordId === undefined || (mode === "save" && ctx.editor.dirty)) {
    // A refused save reports itself in the form's own banner, beside the field it names.
    return { id: await ctx.editor.persist(), error: null }
  }
  if (mode !== "none" && ctx.state !== null && ctx.state.versions.length === 0) {
    const snapshot = await snapshotLiveRow(ctx.client, ctx.model, ctx.recordId)
    if (snapshot.error !== null) return { id: null, error: snapshot.error }
  }
  return { id: ctx.recordId, error: null }
}

/** Publishing the locales, and taking off any time set on them: a schedule left behind would fire again. */
function publishSteps(ctx: Context, locales: string[] | undefined): Step[] {
  const scope = locales === undefined ? {} : { locales }
  const timed = Object.keys(ctx.state?.scheduledAt ?? {})
  const clears = timed.some((l) => locales === undefined || locales.includes(l))
  return [
    (id) => publish(ctx.client, ctx.model, id, scope),
    ...(clears ? [(id: string) => unschedulePublish(ctx.client, ctx.model, id, scope)] : []),
  ]
}

/**
 * The publish panel's actions, with the client and the form bound.
 *
 * Each runs its steps in order and stops at the first refusal. The form hears about every act that
 * reached the record, refused or not, so a record created by a publish whose publish then failed
 * still opens as the record it now is.
 */
export function usePublishActions(
  target: { model: ModelConfig; recordId: string | undefined; state: PublishingState | null },
  editor: RecordEditor,
): PublishActions {
  const client = useAdminClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ctx: Context = { client, ...target, editor }

  const perform = (mode: Prepare, steps: Step[], reloadForm = false): void => {
    setBusy(true)
    setError(null)
    void runSteps(ctx, mode, steps)
      .then((outcome) => {
        // A publish copies the draft into the live row, where the table's constraints hold, so its
        // refusals are the database's and are said in the editor's words like a save's.
        if (outcome.error !== null) setError(explainRefusal({ message: outcome.error }, target.model.fields, {}).banner)
        if (outcome.id !== null) editor.onChanged(outcome.id, reloadForm)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Publishing failed")
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return { busy, error, ...bindActions(ctx, perform) }
}

async function runSteps(
  ctx: Context,
  mode: Prepare,
  steps: Step[],
): Promise<{ id: string | null; error: string | null }> {
  const prepared = await prepare(ctx, mode)
  if (prepared.id === null) return prepared
  for (const step of steps) {
    const result = await step(prepared.id)
    if (result.error !== null) return { id: prepared.id, error: result.error }
  }
  return prepared
}

function bindActions(
  ctx: Context,
  perform: (mode: Prepare, steps: Step[], reloadForm?: boolean) => void,
): Omit<PublishActions, "busy" | "error"> {
  const { client, model } = ctx
  const discardTo = ctx.state?.discardTo ?? null
  return {
    publish: (locales) => {
      perform("save", publishSteps(ctx, locales))
    },
    schedule: (at) => {
      perform("save", [(id) => schedulePublish(client, model, id, at)])
    },
    cancelSchedule: () => {
      perform("none", [(id) => unschedulePublish(client, model, id)])
    },
    // Unsaved edits are dropped by re-reading the form. A saved edit is undone by restoring the
    // published version as the newest draft, which says what is live and so leaves nothing waiting.
    discard: () => {
      perform("none", discardTo === null ? [] : [(id) => restoreVersion(client, model, id, discardTo)], true)
    },
    unpublish: (locales) => {
      perform("snapshot", [(id) => unpublish(client, model, id, locales)])
    },
  }
}
