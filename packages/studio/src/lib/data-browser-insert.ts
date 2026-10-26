import type { SupatypeClient } from "@supatype/client"
import type { ModelConfig } from "../config.js"
import type { SaveChoice } from "../components/database/SaveChoiceDialog.js"
import { createRecord, publish, type RecordError } from "./publishing.js"

/** The table a data browser insert goes into, and the model describing it when one does. */
export interface InsertTarget {
  table: string
  model: ModelConfig | undefined
}

/** How an insert ended: whether the record now exists, and why not, or why it is not live. */
export interface InsertOutcome {
  created: boolean
  /** It exists as a draft only: created on a drafts model and not published. */
  drafted: boolean
  error: RecordError | null
}

/**
 * Insert a row from the data browser.
 *
 * On a model with drafts the record is created as the record editor creates one: through
 * `supatype.create_record`, which leaves it unpublished, then for "publish" through
 * `supatype.publish`. Those are two calls, as in the editor, so a refused publish leaves the
 * record created as a draft, and the outcome says so. With no choice made it stays a draft, so
 * nothing reaches readers unasked. Any other table takes a plain insert.
 */
export async function insertRow(
  client: SupatypeClient,
  target: InsertTarget,
  record: Record<string, unknown>,
  choice: SaveChoice | undefined,
): Promise<InsertOutcome> {
  const model = target.model
  if (model?.versions?.drafts !== true) {
    const { error } = await client.from(target.table).insert(record)
    return { created: error === null, drafted: false, error }
  }
  const created = await createRecord(client, model, record)
  if (created.error !== null || created.id === null) return { created: false, drafted: false, error: created.error }
  if (choice !== "publish") return { created: true, drafted: true, error: null }
  const published = await publish(client, model, created.id)
  if (published.error === null) return { created: true, drafted: false, error: null }
  const message = `The record was created as a draft, but publishing it was refused: ${published.error}`
  return { created: true, drafted: true, error: { message } }
}
