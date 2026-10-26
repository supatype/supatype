import { useEffect, useState, type Dispatch, type SetStateAction } from "react"
import type { SupatypeClient } from "@supatype/client"
import type { ModelConfig } from "../config.js"
import type { RefusalInput } from "../lib/database-refusal.js"
import { saveDrafts } from "../lib/publishing.js"
import type { PendingCellEdit, SaveChoice } from "../components/database/SaveChoiceDialog.js"

/** What saving a data browser cell needs from the view it is in. */
export interface CellSaveDeps {
  client: SupatypeClient
  table: string
  /** The model describing the table, when one does: its drafts decide how an edit is saved. */
  model: ModelConfig | undefined
  pkColumn: string
  /** Report a refused write, placed on the column it names. */
  refuse: (error: RefusalInput, values: Record<string, unknown>) => void
  setRows: Dispatch<SetStateAction<Record<string, unknown>[]>>
  /** Read the rows again, for a publish that may have moved more than the edited cell. */
  refresh: () => void
  /** Say that a write went into a draft, or clear that once it is published. */
  noteDraft: (message: string | null) => void
}

/** A data browser cell edit's save, and what this view knows of the drafts it saved. */
export interface CellSave {
  /** Save the edit: straight to the row, or on a drafts model held for {@link CellSave.answer}. */
  save: (edit: PendingCellEdit) => Promise<void>
  /** The edit waiting for the editor to choose how it is saved. */
  pending: PendingCellEdit | null
  /** Save the held edit as chosen, or drop it on null. */
  answer: (choice: SaveChoice | null) => void
  /** Whether this view saved a draft of the cell that it has not seen published. */
  hasDraft: (rowId: string, column: string) => boolean
}

/** What a draft notice says of the table: it shows what is live. */
const STILL_LIVE = "The live value is unchanged until the record is published."

type DraftedCell = Pick<PendingCellEdit, "rowId" | "column">

function errorOf(err: unknown): RefusalInput {
  return { message: err instanceof Error ? err.message : "Saving the change failed." }
}

/** Write the edit to the live row, then show it there. */
async function saveLive(deps: CellSaveDeps, edit: PendingCellEdit): Promise<void> {
  const data = { [edit.column]: edit.value }
  try {
    const { error } = await deps.client.from(deps.table).update(data).eq(deps.pkColumn, edit.rowId)
    if (error) { deps.refuse(error, data); return }
  } catch (err) {
    deps.refuse(errorOf(err), data)
    return
  }
  deps.setRows((prev) => prev.map((r) => (String(r[deps.pkColumn]) === edit.rowId ? { ...r, ...data } : r)))
}

/** Save the edit as a draft of its record, published too when chosen: whether it went in. */
async function saveDraft(deps: CellSaveDeps, model: ModelConfig, edit: PendingCellEdit, choice: SaveChoice): Promise<boolean> {
  const data = { [edit.column]: edit.value }
  try {
    const { error } = await saveDrafts(deps.client, model, { recordIds: [edit.rowId], data, publish: choice === "publish" })
    if (error === null) return true
    deps.refuse(error, data)
  } catch (err) {
    deps.refuse(errorOf(err), data)
  }
  return false
}

/**
 * Saving a data browser cell. On a model with drafts the edit is held and the editor chooses Save
 * as draft, which leaves the live row as it is, or Save and publish. Anything else saves to the row.
 */
export function useCellSave(deps: CellSaveDeps): CellSave {
  const [pending, setPending] = useState<PendingCellEdit | null>(null)
  const [drafted, setDrafted] = useState<readonly DraftedCell[]>([])
  // What this view saved belongs to the table it saved it in.
  useEffect(() => { setPending(null); setDrafted([]) }, [deps.table])

  const saved = (edit: PendingCellEdit, choice: SaveChoice): void => {
    const cell = { rowId: edit.rowId, column: edit.column }
    const others = (d: DraftedCell): boolean => d.rowId !== cell.rowId || d.column !== cell.column
    // Publishing publishes the record's newest draft, so every cell drafted on its row went live.
    setDrafted((prev) => (choice === "draft" ? [...prev.filter(others), cell] : prev.filter((d) => d.rowId !== cell.rowId)))
    deps.noteDraft(choice === "draft" ? `The change to ${edit.column} is saved as a draft. ${STILL_LIVE}` : null)
    if (choice === "publish") deps.refresh()
  }
  const answer = (choice: SaveChoice | null): void => {
    setPending(null)
    if (choice === null || pending === null || deps.model === undefined) return
    const edit = pending
    void saveDraft(deps, deps.model, edit, choice).then((ok) => { if (ok) saved(edit, choice) })
  }
  return {
    save: async (edit) => { if (deps.model?.versions?.drafts === true) setPending(edit); else await saveLive(deps, edit) },
    pending,
    answer,
    hasDraft: (rowId, column) => drafted.some((d) => d.rowId === rowId && d.column === column),
  }
}
