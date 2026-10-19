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
import type { PanelModel } from "../lib/publish-panel.js"
import type { PanelActions } from "./PublishBar.js"

/** Which question the menu has open, if any. */
export type PublishDialog = "schedule" | "discard" | "unpublish" | null

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
 * The main button says what it will do. Schedule, Discard and Unpublish share the menu, with
 * Unpublish last behind a separator because it is the one that takes something off the live site.
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
          onClick={() => { actions.publish() }}
        >
          <span className="truncate">{panel.primary.label}</span>
        </Button>
        <PublishMenu panel={panel} tone={tone} busy={busy} onOpen={setDialog} onCancelSchedule={actions.cancelSchedule} />
      </ButtonGroup>
      {dialog !== null && <PublishQuestion dialog={dialog} panel={panel} title={title} actions={actions} onClose={close} />}
    </>
  )
}

function PublishMenu({
  panel,
  tone,
  busy,
  onOpen,
  onCancelSchedule,
}: {
  panel: PanelModel
  tone: "primary" | "secondary"
  busy: boolean
  onOpen: (dialog: PublishDialog) => void
  onCancelSchedule: () => void
}): React.ReactElement {
  const { menu } = panel
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={busy}>
        <Button variant={tone} aria-label="More publishing actions">
          <span className="rotate-90"><IconChevronRight size={12} /></span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!menu.canSchedule && !menu.scheduled} onSelect={() => { onOpen("schedule") }}>
          {menu.scheduled ? "Change schedule..." : "Schedule publish..."}
        </DropdownMenuItem>
        {menu.scheduled && <DropdownMenuItem onSelect={onCancelSchedule}>Cancel schedule</DropdownMenuItem>}
        <DropdownMenuItem disabled={!menu.canDiscard} onSelect={() => { onOpen("discard") }}>
          Discard changes
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!menu.canUnpublish} className="text-destructive" onSelect={() => { onOpen("unpublish") }}>
          Unpublish
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  return <UnpublishQuestion {...props} />
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

function UnpublishQuestion({ title, actions, onClose }: QuestionProps): React.ReactElement {
  return (
    <Dialog role="alertdialog" title={`Unpublish "${title}"?`} actions={<Answers label="Unpublish" act={actions.unpublish} onClose={onClose} />}>
      <p>It comes off the live site. Your content is kept as a draft.</p>
    </Dialog>
  )
}