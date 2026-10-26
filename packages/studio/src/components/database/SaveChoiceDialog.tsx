import React from "react"
import { Badge, Button, Card, Dialog } from "../ui.js"

/** A cell edit on a model with drafts, held until the editor says how to save it. */
export interface PendingCellEdit {
  rowId: string
  column: string
  value: unknown
}

/** How a write to a model with drafts is saved: as a draft only, or as a draft and published. */
export type SaveChoice = "draft" | "publish"

/** What the question is about: a change to one column of a record, or a new record in a table. */
export type SaveSubject = { kind: "cell"; column: string } | { kind: "record"; table: string }

/** The question's title and what each answer does, in the subject's words. */
function wording(subject: SaveSubject): { title: string; draft: string; publish: string } {
  if (subject.kind === "record") {
    return {
      title: `Create this record in ${subject.table}?`,
      draft: "Save as draft creates the record unpublished: it is not live until it is published.",
      publish: "Save and publish creates the record and publishes it straight away.",
    }
  }
  return {
    title: `Save the change to ${subject.column}?`,
    draft: "Save as draft keeps the live value as it is until the record is published.",
    publish: "Save and publish puts this change live now, with any earlier draft changes to this record.",
  }
}

/**
 * Asks how to save a write to a model with drafts. The answers match the record editor's Save
 * draft and Publish, and Cancel drops the write. `answer(null)` is Cancel.
 */
export function SaveChoiceDialog({ subject, answer }: {
  subject: SaveSubject
  answer: (choice: SaveChoice | null) => void
}): React.ReactElement {
  const words = wording(subject)
  const actions = (
    <>
      <Button variant="ghost" onClick={() => { answer(null) }}>Cancel</Button>
      <Button onClick={() => { answer("draft") }}>Save as draft</Button>
      <Button variant="primary" onClick={() => { answer("publish") }}>Save and publish</Button>
    </>
  )
  return (
    <Dialog title={words.title} actions={actions}>
      <p>This model keeps drafts.</p>
      <p>{words.draft}</p>
      <p>{words.publish}</p>
    </Dialog>
  )
}

/** Says that a write went into a draft, so the table still shows what is live. */
export function DraftSavedNotice({ message, onDismiss }: { message: string; onDismiss: () => void }): React.ReactElement {
  return (
    <Card role="status" className="mb-3 px-4 py-3 text-xs flex items-center gap-2">
      <Badge variant="indigo">Draft saved</Badge>
      <span className="text-muted-foreground">{message}</span>
      <Button size="xs" className="ml-auto shrink-0" onClick={onDismiss}>Dismiss</Button>
    </Card>
  )
}

/** A cell's live value, marked when a draft of it is waiting to be published. */
export function DraftMarked({ pending, children }: { pending: boolean; children: React.ReactNode }): React.ReactElement {
  if (!pending) return <>{children}</>
  return (
    <span className="flex items-center gap-1.5">
      {children}
      <Badge variant="indigo" title="A draft of this value is saved and not yet published. This is the live value.">Draft</Badge>
    </span>
  )
}
