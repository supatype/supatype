/**
 * The rename journal (RN1): `supatype/renames.json`, committed with the project.
 *
 * Renames are declared, never guessed (D1), and Supatype has no migration files, so the answer to
 * "was this a rename?" has to live somewhere every environment reads: the developer's database, a
 * teammate's, staging and production. The engine offers the likely pairs (`renameCandidates`), a
 * person answers once, and the answer is recorded here with who gave it and when. The schema code
 * stays as the person wrote it.
 *
 * Every schema the CLI builds carries the journal ({@link withRenameJournal}) as its
 * `renameJournal`, and the engine reads each entry as a declared rename. A database that still has
 * the old column renames it; one two renames behind follows the chain back to the name it has; one
 * that has already applied the rename, or never had the old column, does nothing. An entry is
 * removed only by `supatype rename --prune`, once the target database's history shows it applied.
 */
import { randomUUID } from "node:crypto"
import { errorMessage } from "./error-message.js"
import { isJsonObject } from "@supatype/shared"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { RenameCandidate } from "./engine-client.js"
import type { RenameDeclarationWriter } from "./destructive-consent.js"
import { projectAuthor } from "./push-audit.js"
import type { MigrationListEntry } from "./resolve-target.js"
import type { ExtractedSchemaAstV2 } from "./schema-ast-v2.js"

/** Where the journal lives, relative to the directory holding `supatype.config.ts`. */
export const RENAME_JOURNAL_FILE = "supatype/renames.json"

/** The journal format this CLI reads and writes. A newer one is refused, never rewritten. */
export const RENAME_JOURNAL_VERSION = 1

/** One recorded answer: `from` was renamed to `to`, said by `declared_by` at `declared_at`. */
export interface RenameJournalEntry extends RenameCandidate {
  id: string
  /** `Name <email>` from git, else the OS user marked unverified. */
  declared_by: string
  /** ISO 8601. */
  declared_at: string
}

export interface RenameJournal {
  version: typeof RENAME_JOURNAL_VERSION
  renames: RenameJournalEntry[]
}

/** A rename a database's history records as applied, with who declared it when it knows. */
export interface AppliedRenameRecord extends RenameCandidate {
  declared_by?: string | null
  declared_at?: string | null
}

/** The journal's path for the project at `cwd`. */
export function renameJournalPath(cwd: string): string {
  return join(cwd, RENAME_JOURNAL_FILE)
}

/** The project's journal, empty when there is none yet. Throws on one this CLI cannot read. */
export function readRenameJournal(cwd: string): RenameJournal {
  const path = renameJournalPath(cwd)
  if (!existsSync(path)) return { version: RENAME_JOURNAL_VERSION, renames: [] }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    throw new Error(`${RENAME_JOURNAL_FILE} is not valid JSON: ${errorMessage(err)}`)
  }
  return parseJournal(raw)
}

function parseJournal(raw: unknown): RenameJournal {
  if (!isJsonObject(raw)) throw malformed("expected an object")
  const { version, renames } = raw
  if (version !== RENAME_JOURNAL_VERSION) {
    throw new Error(
      `${RENAME_JOURNAL_FILE} is version ${String(version)}, and this CLI reads version ` +
        `${RENAME_JOURNAL_VERSION}. Update the CLI rather than edit the file.`,
    )
  }
  if (!Array.isArray(renames)) throw malformed("`renames` must be a list")
  return { version: RENAME_JOURNAL_VERSION, renames: renames.map(parseEntry) }
}

function parseEntry(raw: unknown, index: number): RenameJournalEntry {
  const entry = isJsonObject(raw) ? raw : {}
  const text = (key: string): string => {
    const value = entry[key]
    if (typeof value !== "string" || value === "") throw malformed(`entry ${index + 1} has no ${key}`)
    return value
  }
  const kind = text("kind")
  if (kind !== "column" && kind !== "table") throw malformed(`entry ${index + 1} has kind "${kind}"`)
  return {
    id: text("id"),
    kind,
    table: text("table"),
    from: text("from"),
    to: text("to"),
    declared_by: text("declared_by"),
    declared_at: text("declared_at"),
  }
}

function malformed(why: string): Error {
  return new Error(`${RENAME_JOURNAL_FILE} is malformed: ${why}.`)
}

/** Write `journal` for the project at `cwd`, through a temporary file so a reader never sees half. */
export function writeRenameJournal(cwd: string, journal: RenameJournal): void {
  const path = renameJournalPath(cwd)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(journal, null, 2)}\n`, "utf8")
  renameSync(temp, path)
}

function sameRename(a: RenameCandidate, b: RenameCandidate): boolean {
  return a.kind === b.kind && a.table === b.table && a.from === b.from && a.to === b.to
}

/** Record `rename` as declared by `declaredBy`, once: an entry already there is returned as it is. */
export function appendRename(
  cwd: string,
  rename: RenameCandidate,
  declaredBy: string,
  now: Date = new Date(),
): RenameJournalEntry {
  const journal = readRenameJournal(cwd)
  const existing = journal.renames.find((entry) => sameRename(entry, rename))
  if (existing !== undefined) return existing
  const entry: RenameJournalEntry = {
    id: randomUUID(),
    kind: rename.kind,
    table: rename.table,
    from: rename.from,
    to: rename.to,
    declared_by: declaredBy,
    declared_at: now.toISOString(),
  }
  writeRenameJournal(cwd, { ...journal, renames: [...journal.renames, entry] })
  return entry
}

/**
 * The writer `pushConsentingToDestructive` records a terminal's "yes" through. The author is asked
 * for only when there is a rename to record.
 */
export function journalRenameWriter(
  cwd: string,
  declaredBy: () => string = () => projectAuthor(cwd),
): RenameDeclarationWriter {
  return {
    write: async (candidate) => {
      appendRename(cwd, candidate, declaredBy())
    },
  }
}

/** `table.from -> to`, or `table from -> to`: how a rename is named wherever it is shown. */
export function renameLabel(r: RenameCandidate): string {
  return r.kind === "table" ? `table ${r.from} -> ${r.to}` : `${r.table}.${r.from} -> ${r.to}`
}

/** The command that records `candidate`, as a push refused off a terminal names it. */
export function renameCommandHint(candidate: RenameCandidate): string {
  return candidate.kind === "table"
    ? `supatype rename ${candidate.from} ${candidate.to}`
    : `supatype rename ${candidate.table}.${candidate.from} ${candidate.table}.${candidate.to}`
}

// ─── Replay ──────────────────────────────────────────────────────────────────

/** `ast` carrying the journal as its `renameJournal`, for the engine to read; `ast` itself is kept. */
export function withRenameJournal(ast: ExtractedSchemaAstV2, journal: RenameJournal): ExtractedSchemaAstV2 {
  return journal.renames.length === 0 ? ast : { ...ast, renameJournal: journal.renames }
}

// ─── Pruning ─────────────────────────────────────────────────────────────────

/** A migration as `migrations list` reads it: only what pruning needs. */
export type MigrationRenames = Partial<Pick<MigrationListEntry, "status" | "rolledBack" | "renames">>

/** Every rename a database's history records as applied and still in force. */
export function appliedRenames(migrations: readonly MigrationRenames[]): RenameCandidate[] {
  return migrations
    .filter((m) => m.rolledBack !== true && (m.status ?? "applied") === "applied")
    .flatMap((m) => m.renames ?? [])
    .map(({ kind, table, from, to }) => ({ kind, table, from, to }))
}

/** `journal` without the entries `applied` records, and the entries taken out. */
export function pruneJournal(
  journal: RenameJournal,
  applied: readonly RenameCandidate[],
): { journal: RenameJournal; removed: RenameJournalEntry[] } {
  const isApplied = (entry: RenameJournalEntry) => applied.some((a) => sameRename(a, entry))
  return {
    journal: { ...journal, renames: journal.renames.filter((entry) => !isApplied(entry)) },
    removed: journal.renames.filter(isApplied),
  }
}
