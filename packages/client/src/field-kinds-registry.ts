/**
 * Which columns hold values a JSON parser would destroy, told to the client by generated code.
 *
 * `supatype push` writes `supatype/generated/client.ts` into the project. That file calls
 * {@link registerFieldKinds} at import time and re-exports `createClient`, so an app writes
 *
 *     import { createClient } from "./supatype/generated/client"
 *
 * and the kinds arrive by the same import that brings the client. They are compiled into the same
 * bundle, so there is nothing to fetch, nothing to read from disk, and nothing that can be stale
 * relative to the code that shipped.
 *
 * This replaced reading the kinds off the filesystem with a fetch of PostgREST's OpenAPI document
 * as a fallback. That fallback reconstructed the answer from the live database, so it always
 * succeeded, which meant a project that had never generated was indistinguishable from one that
 * had. The gap could not be reported because nothing could detect it. Here, absence is a fact:
 * {@link fieldKindsAreRegistered} is false, and the caller can say so.
 */
import type { ExactFields, ExactKind } from "./exact-values.js"
import { isJsonObject, isOneOf } from "./json.js"

/** Table name to its exact-value columns. */
export type ExactFieldsByTable = Readonly<Record<string, ExactFields>>

/** The shape the generated file passes. Versioned so an older client declines a newer one. */
export type FieldKindsDocument = {
  readonly version: 1
  readonly tables: Readonly<Record<string, Readonly<Record<string, ExactKind>>>>
}

/**
 * A document from a generator this client predates: a version it does not know, or kinds it does
 * not. Accepted so that generated code type-checks against an older client, and then ignored.
 */
export type UnrecognisedFieldKindsDocument = {
  readonly version: number
  readonly tables: unknown
}

const SUPPORTED_VERSION = 1
const isExactKind = isOneOf(["bigint", "numeric"])
const NO_FIELDS: ExactFields = {}

// Module level, and deliberately not per client. Server-side rendering builds a client per
// request, and the schema does not change between them.
let registered: ExactFieldsByTable | null = null

/**
 * Record a project's exact-value columns. Called by generated code, not by hand.
 *
 * A document whose version this client does not understand is ignored rather than guessed at: a
 * newer shape read by older rules is how a client starts converting the wrong columns.
 */
export function registerFieldKinds(document: FieldKindsDocument | UnrecognisedFieldKindsDocument): void {
  // Checked as JSON, whatever the type says: plain JavaScript calls this too.
  if (!isJsonObject(document)) return
  if (document["version"] !== SUPPORTED_VERSION) return
  const declared = document["tables"]
  if (!isJsonObject(declared)) return

  const tables: Record<string, ExactFields> = {}
  for (const [table, columns] of Object.entries(declared)) {
    if (!isJsonObject(columns)) continue
    const fields: Record<string, ExactKind> = {}
    for (const [column, kind] of Object.entries(columns)) {
      if (isExactKind(kind)) fields[column] = kind
    }
    if (Object.keys(fields).length > 0) tables[table] = fields
  }

  registered = tables
}

/** The exact-value columns of one table, or none when the table has any. */
export function registeredFieldsFor(table: string): ExactFields {
  return registered?.[table] ?? NO_FIELDS
}

/**
 * Whether generated code has registered anything at all.
 *
 * Distinct from a table having no exact columns. A project with no `bigInt`, `decimal` or `money`
 * anywhere still generated, and shouting at it would be wrong; a project that never generated is
 * the case worth reporting.
 */
export function fieldKindsAreRegistered(): boolean {
  return registered !== null
}

/** Forget what was registered. For tests, and for a process that switches projects. */
export function forgetRegisteredFieldKinds(): void {
  registered = null
}
