import React, { useCallback, useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { isDestructiveSql } from "../../lib/sql-destructive.js"
import { Button, CodeBlock, ConfirmButton, Dialog, Textarea, type DestructiveQuestion } from "../ui.js"

/** A statement drafted for review: open while `text` is not null, and what running it is doing. */
export interface SqlDraft {
  schema: string
  /** The statement under review, or null when no draft is open. */
  text: string | null
  /** The review's heading, such as `Drop table orders`; plain `SQL` unless the opener names it. */
  title: string
  /** Opens the draft with `sql` under `title` (plain `SQL` when none is given). */
  open: (sql: string, title?: string) => void
  /** Replaces the open draft's text, as typing in the box does. */
  setText: (sql: string) => void
  close: () => void
  run: () => Promise<void>
  busy: boolean
  error: string | null
}

const PLAIN_TITLE = "SQL"

/** A draft whose statement runs on `schema` through the SQL editor's route, then calls `onRan`. */
export function useSqlDraft(schema: string, onRan: () => void): SqlDraft {
  const proxy = useProjectProxy()
  const [text, setText] = useState<string | null>(null)
  const [title, setTitle] = useState(PLAIN_TITLE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = useCallback((sql: string, next = PLAIN_TITLE): void => { setTitle(next); setText(sql) }, [])
  const close = useCallback(() => { setText(null); setError(null) }, [])
  const run = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await proxy.sql(text ?? "", schema)
      setText(null)
      onRan()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [proxy, text, schema, onRan])
  return { schema, text, title, open, setText, close, run, busy, error }
}

/** The second question a destructive draft asks: the statement as it will run, and where. */
function runQuestion(schema: string, sql: string): DestructiveQuestion {
  return {
    title: `Run this SQL on ${schema}?`,
    detail: (
      <>
        <p>It runs as written, at once, and cannot be undone from here.</p>
        <CodeBlock className="p-2 text-xs text-foreground whitespace-pre-wrap break-all">{sql}</CodeBlock>
      </>
    ),
    answer: `Run on ${schema}`,
  }
}

/**
 * The drafted statement, editable, with Run. Opening the draft is the review. Run asks a second
 * question only when the statement as it now reads drops or destroys something
 * ({@link isDestructiveSql}), and is red when it does; anything else runs on the click.
 */
export function SqlDraftDialog({ draft }: { draft: SqlDraft }): React.ReactElement | null {
  if (draft.text === null) return null
  const label = draft.busy ? "Running…" : "Run SQL"
  const run = isDestructiveSql(draft.text)
    ? <ConfirmButton variant="destructive" disabled={draft.busy} ask={runQuestion(draft.schema, draft.text)} act={() => { void draft.run() }}>{label}</ConfirmButton>
    : <Button variant="primary" disabled={draft.busy} onClick={() => { void draft.run() }}>{label}</Button>
  return (
    <Dialog title={draft.title} actions={<><Button onClick={draft.close}>Cancel</Button>{run}</>}>
      <Textarea aria-label="SQL" className="min-h-[140px] resize-y" value={draft.text} onChange={(e) => { draft.setText(e.target.value) }} />
      {draft.error ? <p className="text-xs text-destructive-text">{draft.error}</p> : null}
    </Dialog>
  )
}
