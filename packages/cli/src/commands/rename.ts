/**
 * `supatype rename`: record a rename in the project's journal (`supatype/renames.json`) without a
 * terminal to ask on, for CI and agents. A push that is refused off a terminal names this command
 * for each rename the engine offered. `--prune` removes the entries a target database's history
 * records as applied, and nothing else: an entry is never removed automatically.
 */
import type { Command } from "commander"
import type { RenameCandidate } from "../engine-client.js"
import { authorSources, resolveAuthor } from "../push-audit.js"
import {
  RENAME_JOURNAL_FILE,
  appendRename,
  appliedRenames,
  pruneJournal,
  readRenameJournal,
  renameLabel,
  writeRenameJournal,
  type MigrationRenames,
} from "../rename-journal.js"
import { targetListMigrations } from "../resolve-target.js"
import { info, plain } from "../ui/messages.js"
import { migrationsTarget, type MigrationsTargetOptions } from "./migrate.js"

const USAGE = "Give `<table>.<column> <table>.<column>` for a column, or two table names for a table."

/** `<table>.<from> <table>.<to>` as a column rename, or two bare names as a table rename. */
export function parseRenameArgs(from: string, to: string): RenameCandidate {
  const source = from.split(".")
  const target = to.split(".")
  if (source.length !== target.length || source.length > 2) {
    throw new Error(`Cannot read "${from}" -> "${to}" as a rename. ${USAGE}`)
  }
  if (source.length === 1) {
    if (from === to) throw new Error(`"${from}" and "${to}" are the same name. ${USAGE}`)
    return { kind: "table", table: from, from, to }
  }
  const [table, column] = source as [string, string]
  const [toTable, toColumn] = target as [string, string]
  if (table !== toTable) {
    throw new Error(`A column is renamed within the same table: "${from}" and "${to}" name two. ${USAGE}`)
  }
  if (column === toColumn) throw new Error(`"${from}" and "${to}" are the same name. ${USAGE}`)
  return { kind: "column", table, from: column, to: toColumn }
}

/** Record `rename` in the journal of the project at `cwd`, as declared by `author`. */
export function recordRename(cwd: string, rename: RenameCandidate, author: string): void {
  const entry = appendRename(cwd, rename, author)
  info(
    `Recorded in ${RENAME_JOURNAL_FILE}: ${renameLabel(entry)}, declared by ${entry.declared_by}. ` +
      "Commit the file: every " +
      "push replays it, so each database renames rather than drops.",
  )
}

/**
 * Remove from the journal of the project at `cwd` each rename the target's history (`list`) records
 * as applied, saying what was removed and what was kept. Returns how many were removed.
 */
export async function pruneRenames(cwd: string, list: () => Promise<readonly MigrationRenames[]>): Promise<number> {
  const journal = readRenameJournal(cwd)
  const { journal: kept, removed } = pruneJournal(journal, appliedRenames(await list()))
  if (removed.length > 0) writeRenameJournal(cwd, kept)
  for (const entry of removed) plain(`  removed ${renameLabel(entry)}`)
  info(
    `${removed.length} rename(s) removed from ${RENAME_JOURNAL_FILE}, ${kept.renames.length} rename(s) kept. ` +
      "An entry is removed once this database has applied it, so prune against the last environment " +
      "to receive a rename: one that has not applied it yet still needs the entry.",
  )
  return removed.length
}

export function registerRename(program: Command): void {
  program
    .command("rename")
    .description(
      `Record a rename in ${RENAME_JOURNAL_FILE}, so every push applies it as a rename and keeps the data: ` +
        "`supatype rename member.name member.title`, or `supatype rename member members` for a table",
    )
    .argument("[from]", "<table>.<column>, or a table")
    .argument("[to]", "<table>.<column>, or a table")
    .option("--prune", "Remove the renames the target database records as applied")
    .option("--connection <url>", "With --prune: the database to ask (overrides config)")
    .option("--env <name>", "With --prune: the target environment when linked")
    .option("--direct", "With --prune: use the local engine subprocess (skip control plane)")
    .action(async (from: string | undefined, to: string | undefined, opts: MigrationsTargetOptions & { prune?: boolean }) => {
      const cwd = process.cwd()
      if (opts.prune === true) {
        await pruneRenames(cwd, () => targetListMigrations(migrationsTarget(cwd, opts)))
        return
      }
      if (from === undefined || to === undefined) throw new Error(`Name the rename. ${USAGE}`)
      recordRename(cwd, parseRenameArgs(from, to), resolveAuthor(authorSources(cwd)))
    })
}
