import React, { useState } from "react"
import { Button, ButtonGroup, DestructiveAnswers, Dialog } from "./ui.js"
import { IconChevronRight } from "./icons.js"
import { ScheduleControl } from "./ScheduleControl.js"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.js"
import type { Language, PanelModel } from "../lib/publish-panel.js"
import type { PanelActions } from "./PublishBar.js"

/**
 * Which question the menu has open, if any. `unpublish` withdraws the whole record (every language
 * of a localized one); `unpublish-language` withdraws only the language on screen.
 */
export type PublishDialog = "schedule" | "discard" | "unpublish" | "unpublish-language" | null

interface SplitProps {
  panel: PanelModel
  title: string
  busy: boolean
  actions: PanelActions
  /** The question open on first render. For the suites, which render static markup. */
  initialDialog?: PublishDialog
}

/**
 * Publish, with the rarer acts in a menu beside it.
 *
 * The main button says what it will do, and on a localized model publishes only the language on
 * screen. Publishing every language, Schedule and Discard share the menu, with the unpublish acts
 * last behind a separator because they take something off the live site.
 */
export function PublishSplitButton({ panel, title, busy, actions, initialDialog = null }: SplitProps): React.ReactElement {
  const [dialog, setDialog] = useState<PublishDialog>(initialDialog)
  const close = (): void => { setDialog(null) }
  // One variant for both halves. With nothing to publish the pair steps back to secondary, so the
  // joined control keeps one colour whichever half is usable.
  const tone = panel.primary.disabled ? "secondary" : "primary"
  return (
    <>
      <ButtonGroup split className="grow basis-40">
        <Button
          variant={tone}
          // Nothing to publish greys the label, not the whole half: the menu beside it still works
          // (Unpublish, Schedule), and a dimmed half next to a bright one read as two controls.
          className="flex-1 min-w-0 justify-center disabled:opacity-100 disabled:text-muted-foreground"
          disabled={busy || panel.primary.disabled}
          title={panel.primary.disabled ? (panel.note ?? undefined) : undefined}
          onClick={() => { actions.publish(panel.language === null ? undefined : [panel.language.code]) }}
        >
          <span className="truncate">{panel.primary.label}</span>
        </Button>
        <PublishMenu panel={panel} tone={tone} busy={busy} onOpen={setDialog} actions={actions} />
      </ButtonGroup>
      {dialog !== null && <PublishQuestion dialog={dialog} panel={panel} title={title} actions={actions} onClose={close} />}
    </>
  )
}

interface MenuProps {
  panel: PanelModel
  tone: "primary" | "secondary"
  busy: boolean
  onOpen: (dialog: PublishDialog) => void
  actions: PanelActions
}

function PublishMenu({ panel, tone, busy, onOpen, actions }: MenuProps): React.ReactElement {
  const { menu, language } = panel
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={busy}>
        <Button variant={tone} aria-label="More publishing actions">
          <span className="rotate-90"><IconChevronRight size={12} /></span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {language !== null && (
          <DropdownMenuItem disabled={!menu.canPublishAll} onSelect={() => { actions.publish() }}>
            Publish all languages
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={!menu.canPublishAll && !menu.scheduled} onSelect={() => { onOpen("schedule") }}>
          {menu.scheduled ? "Change schedule..." : "Schedule publish..."}
        </DropdownMenuItem>
        {menu.scheduled && <DropdownMenuItem onSelect={actions.cancelSchedule}>Cancel schedule</DropdownMenuItem>}
        <DropdownMenuItem disabled={!menu.canDiscard} onSelect={() => { onOpen("discard") }}>
          Discard changes
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <UnpublishItems panel={panel} onOpen={onOpen} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type UnpublishScope = "unpublish" | "unpublish-language"

/**
 * What an unpublish is called, on its menu item and on the answer that confirms it: "Unpublish" for
 * a record that publishes as a whole, "Unpublish in {language}" or "Unpublish all languages" else.
 */
function unpublishLabel(scope: UnpublishScope, language: Language | null): string {
  if (language === null) return "Unpublish"
  return scope === "unpublish" ? "Unpublish all languages" : `Unpublish in ${language.label}`
}

/** "Unpublish" for a record that publishes as a whole; the language on screen, then all, for a localized one. */
function UnpublishItems({ panel, onOpen }: { panel: PanelModel; onOpen: (dialog: PublishDialog) => void }): React.ReactElement {
  const { menu, language } = panel
  const item = (scope: UnpublishScope, enabled: boolean): React.ReactElement => (
    <DropdownMenuItem key={scope} disabled={!enabled} className="text-destructive" onSelect={() => { onOpen(scope) }}>
      {unpublishLabel(scope, language)}
    </DropdownMenuItem>
  )
  if (language === null) return item("unpublish", menu.canUnpublishAll)
  return <>{[item("unpublish-language", menu.canUnpublishOne), item("unpublish", menu.canUnpublishAll)]}</>
}

interface QuestionProps {
  panel: PanelModel
  title: string
  actions: PanelActions
  onClose: () => void
}

/** The question an act asks before it runs. Every answer closes it. */
function PublishQuestion({ dialog, ...props }: QuestionProps & { dialog: Exclude<PublishDialog, null> }): React.ReactElement {
  if (dialog === "schedule") return <ScheduleQuestion {...props} />
  if (dialog === "discard") return <DiscardQuestion {...props} />
  return <UnpublishQuestion {...props} scope={dialog} />
}

function ScheduleQuestion({ panel, actions, onClose }: QuestionProps): React.ReactElement {
  return (
    <Dialog title={panel.menu.scheduled ? "Change schedule" : "Schedule publish"} actions={<Button onClick={onClose}>Cancel</Button>}>
      <p>Pick when this goes live. Unsaved edits are saved as a draft first.</p>
      <ScheduleControl
        scheduledFor={null}
        busy={false}
        onSchedule={(at) => { onClose(); actions.schedule(at) }}
        onCancel={onClose}
      />
    </Dialog>
  )
}

function DiscardQuestion({ title, actions, onClose }: QuestionProps): React.ReactElement {
  return (
    <Dialog role="alertdialog" title={`Discard changes to "${title}"?`} actions={<DestructiveAnswers label="Discard changes" act={actions.discard} onClose={onClose} />}>
      <p>The draft goes back to the published version.</p>
      <p>Unsaved edits are lost. Saved ones stay in the version history.</p>
    </Dialog>
  )
}

/** What an unpublish asks, and which locales it withdraws: undefined for every one. */
interface UnpublishWords {
  question: string
  body: string
  locales: string[] | undefined
}

const KEPT = "Your content is kept as a draft."

function unpublishWords(scope: UnpublishScope, language: Language | null, title: string): UnpublishWords {
  if (language === null) {
    return { question: `Unpublish "${title}"?`, body: `It comes off the live site. ${KEPT}`, locales: undefined }
  }
  if (scope === "unpublish") {
    const body = `It comes off the live site in every language. ${KEPT}`
    return { question: `Unpublish "${title}" in all languages?`, body, locales: undefined }
  }
  const { code, label } = language
  return {
    question: `Unpublish "${title}" in ${label}?`,
    body: `${label} comes off the live site. Other languages stay as they are. ${KEPT}`,
    locales: [code],
  }
}

function UnpublishQuestion({ scope, panel, title, actions, onClose }: QuestionProps & { scope: UnpublishScope }): React.ReactElement {
  const words = unpublishWords(scope, panel.language, title)
  const act = (): void => { actions.unpublish(words.locales) }
  const answers = <DestructiveAnswers label={unpublishLabel(scope, panel.language)} act={act} onClose={onClose} />
  return (
    <Dialog role="alertdialog" title={words.question} actions={answers}>
      <p>{words.body}</p>
    </Dialog>
  )
}
