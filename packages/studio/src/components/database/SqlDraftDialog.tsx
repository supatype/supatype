import React, { useCallback, useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { Button, CodeBlock, ConfirmButton, Dialog, Textarea } from "../ui.js"

/** A statement drafted for review: open while `text` is not null, and what running it is doing. */
export interface SqlDraft {
  schema: string
  /** The statement under review, or null when no draft is open. */
  text: string | null
  /** Opens the draft with `sql`, or replaces the open draft's text with it. */
  setText: (sql: string) => void
  close: () => void
  run: () => Promise<void>
  busy: boolean
  error: string | null
}

/** A draft whose statement runs on `schema` through the SQL editor's route, then calls `onRan`. */
export function useSqlDraft(schema: string, onRan: () => void): SqlDraft {
  const proxy = useProjectProxy()
  const [text, setDraftText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = useCallback(() => { setDraftText(null); setError(null) }, [])
  const run = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await proxy.sql(text ?? "", schema)
      setDraftText(null)
      onRan()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [proxy, text, schema, onRan])
  return { schema, text, setText: setDraftText, close, run, busy, error }
}

/**
 * The drafted statement, editable, with Run. Run asks first: the statement is whatever the user
 * left in the box, and once it has run on the schema there is nothing to undo it with.
 */
export function SqlDraftDialog({ draft }: { draft: SqlDraft }): React.ReactElement | null {
  if (draft.text === null) return null
  const ask = {
    title: `Run this SQL on ${draft.schema}?`,
    detail: (
      <>
        <p>It runs as written, at once, and cannot be undone from here.</p>
        <CodeBlock className="p-2 text-xs text-foreground whitespace-pre-wrap break-all">{draft.text}</CodeBlock>
      </>
    ),
    answer: `Run on ${draft.schema}`,
  }
  const actions = (
    <>
      <Button onClick={draft.close}>Cancel</Button>
      <ConfirmButton variant="primary" disabled={draft.busy} ask={ask} act={() => { void draft.run() }}>{draft.busy ? "Running…" : "Run SQL"}</ConfirmButton>
    </>
  )
  return (
    <Dialog title="SQL" actions={actions}>
      <Textarea aria-label="SQL" className="min-h-[140px] resize-y" value={draft.text} onChange={(e) => { draft.setText(e.target.value) }} />
      {draft.error ? <p className="text-xs text-destructive-text">{draft.error}</p> : null}
    </Dialog>
  )
}
