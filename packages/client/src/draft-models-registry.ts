/**
 * Which tables belong to models that keep drafts, told to the client by generated code.
 *
 * `supatype push` writes `supatype/generated/client.ts`, which calls {@link registerDraftModels} at import
 * time, as it calls `registerFieldKinds`. The client reads it to send `insert` on such a table
 * through `supatype.create_record`, or `supatype.create_records` for several rows, rather than a
 * plain `POST`.
 *
 * # Why an insert needs to know
 *
 * A new record on a drafts model is unpublished. When the model's read rule hides unpublished rows
 * (`published_at <= now()`), Postgres refuses a plain insert that asks for the row back: it checks
 * the returned row against the read rule as the row is inserted, before anything has made it visible
 * to its author. `create_record` inserts without reading back and writes version 1, after which the
 * record is visible to whoever created it. Studio has always created records that way; this lets an
 * app's `insert` do the same without knowing it has to.
 *
 * Nothing registered means nothing is routed: a client built from `@supatype/client` directly, with
 * no generated file, inserts as it always has.
 */
import { isJsonObject } from "./json.js"

/** What the client needs of one drafts model to create a record and read it back. */
export type DraftModel = {
  /** The column the table is keyed by, which the new record is read back through. */
  readonly primaryKey: string
}

/** The shape the generated file passes. Versioned so an older client declines a newer one. */
export type DraftModelsDocument = {
  readonly version: 1
  readonly tables: Readonly<Record<string, DraftModel>>
}

/** A document from a generator this client predates. Accepted so generated code compiles, then ignored. */
export type UnrecognisedDraftModelsDocument = {
  readonly version: number
  readonly tables: unknown
}

const SUPPORTED_VERSION = 1

// Module level, as the field kinds are: the schema does not change between the clients a server
// builds per request.
let registered: ReadonlyMap<string, DraftModel> | null = null

/** One table's entry, or null when it is not a usable one. */
function draftModelOf(entry: unknown): DraftModel | null {
  if (!isJsonObject(entry)) return null
  const primaryKey = entry["primaryKey"]
  return typeof primaryKey === "string" && primaryKey !== "" ? { primaryKey } : null
}

/**
 * Record which tables keep drafts. Called by generated code, not by hand.
 *
 * Checked as JSON whatever the type says, since plain JavaScript calls this too, and a version this
 * client does not know is ignored rather than read by the wrong rules.
 */
export function registerDraftModels(document: DraftModelsDocument | UnrecognisedDraftModelsDocument): void {
  if (!isJsonObject(document) || document["version"] !== SUPPORTED_VERSION) return
  const declared = document["tables"]
  if (!isJsonObject(declared)) return

  const tables = new Map<string, DraftModel>()
  for (const [table, entry] of Object.entries(declared)) {
    const model = draftModelOf(entry)
    if (model !== null) tables.set(table, model)
  }
  registered = tables
}

/** The drafts model behind `table`, or undefined when the table keeps no drafts. */
export function registeredDraftModel(table: string): DraftModel | undefined {
  return registered?.get(table)
}

/** Forget what was registered. For tests, and for a process that switches projects. */
export function forgetRegisteredDraftModels(): void {
  registered = null
}
