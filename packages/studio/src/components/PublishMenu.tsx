import React, { useState } from "react"
import { Button, ButtonGroup, Dialog } from "./ui.js"
import { IconChevronRight } from "./icons.js"
import { ScheduleControl } from "./ScheduleControl.js"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.js"
import type { LanguageMenu, PanelModel } from "../lib/publish-panel.js"
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
          onClick={() => { actions.publish(panel.primary.locales ?? undefined) }}
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
  const { menu } = panel
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={busy}>
        <Button variant={tone} aria-label="More publishing actions">
          <span className="rotate-90"><IconChevronRight size={12} /></span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {menu.languages !== null && (
          <DropdownMenuItem disabled={!menu.languages.canPublishAll} onSelect={() => { actions.publish() }}>
            Publish all languages
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={!menu.canSchedule && !menu.scheduled} onSelect={() => { onOpen("schedule") }}>
          {menu.scheduled ? "Change schedule..." : "Schedule publish..."}
        </DropdownMenuItem>
        {menu.scheduled && <DropdownMenuItem onSelect={actions.cancelSchedule}>Cancel schedule</DropdownMenuItem>}
        <DropdownMenuItem disabled={!menu.canDiscard} onSelect={() => { onOpen("discard") }}>
          Discard changes
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <UnpublishItems menu={menu} onOpen={onOpen} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** "Unpublish" for a record that publishes as a whole; the language on screen, then all, for a localized one. */
function UnpublishItems({ menu, onOpen }: { menu: PanelModel["menu"]; onOpen: (dialog: PublishDialog) => void }): React.ReactElement {
  const { languages } = menu
  const all = (
    <DropdownMenuItem disabled={!menu.canUnpublish} className="text-destructive" onSelect={() => { onOpen("unpublish") }}>
      {languages === null ? "Unpublish" : "Unpublish all languages"}
    </DropdownMenuItem>
  )
  if (languages === null) return all
  return (
    <>
      <DropdownMenuItem disabled={!languages.canUnpublishOne} className="text-destructive" onSelect={() => { onOpen("unpublish-language") }}>
        {`Unpublish in ${languages.language.label}`}
      </DropdownMenuItem>
      {all}
    </>
  )
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

/** Cancel, and the destructive answer that runs `act`. */
function Answers({ label, act, onClose }: { label: string; act: () => void; onClose: () => void }): React.ReactElement {
  return (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="destructive" onClick={() => { onClose(); act() }}>{label}</Button>
    </>
  )
}

function DiscardQuestion({ title, actions, onClose }: QuestionProps): React.ReactElement {
  return (
    <Dialog role="alertdialog" title={`Discard changes to "${title}"?`} actions={<Answers label="Discard changes" act={actions.discard} onClose={onClose} />}>
      <p>The draft goes back to the published version.</p>
      <p>Unsaved edits are lost. Saved ones stay in the version history.</p>
    </Dialog>
  )
}

/** What an unpublish asks, what its answer says, and which locales it withdraws: undefined for every one. */
interface UnpublishWords {
  question: string
  body: string
  answer: string
  locales: string[] | undefined
}

const KEPT = "Your content is kept as a draft."

function unpublishWords(scope: "unpublish" | "unpublish-language", languages: LanguageMenu | null, title: string): UnpublishWords {
  if (languages === null) {
    return { question: `Unpublish "${title}"?`, body: `It comes off the live site. ${KEPT}`, answer: "Unpublish", locales: undefined }
  }
  if (scope === "unpublish") {
    const body = `It comes off the live site in every language. ${KEPT}`
    return { question: `Unpublish "${title}" in all languages?`, body, answer: "Unpublish all languages", locales: undefined }
  }
  const { code, label } = languages.language
  return {
    question: `Unpublish "${title}" in ${label}?`,
    body: `${label} comes off the live site. Other languages stay as they are. ${KEPT}`,
    answer: `Unpublish in ${label}`,
    locales: [code],
  }
}

function UnpublishQuestion({ scope, panel, title, actions, onClose }: QuestionProps & { scope: "unpublish" | "unpublish-language" }): React.ReactElement {
  const words = unpublishWords(scope, panel.menu.languages, title)
  const act = (): void => { actions.unpublish(words.locales) }
  return (
    <Dialog role="alertdialog" title={words.question} actions={<Answers label={words.answer} act={act} onClose={onClose} />}>
      <p>{words.body}</p>
    </Dialog>
  )
}
