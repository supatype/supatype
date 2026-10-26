import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  RENAME_JOURNAL_FILE,
  appendRename,
  appliedRenames,
  journalRenameWriter,
  renameLabel,
  withRenameJournal,
  pruneJournal,
  readRenameJournal,
  type RenameJournalEntry,
} from "../src/rename-journal.js"
import type { ExtractedSchemaAstV2 } from "../src/schema-ast-v2.js"

/**
 * RN1 (revised): a rename is detected by the engine, asked about once, and recorded in a file the
 * project commits, `supatype/renames.json`. Every environment replays it: every schema the CLI
 * builds carries it as `renameJournal`, the engine reads each entry as a declared rename, and a
 * database that has already applied it does nothing. Schema code stays clean.
 */

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "rename-journal-"))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

const column = { kind: "column" as const, table: "member", from: "name", to: "title" }
const at = new Date("2026-10-12T10:00:00.000Z")

function journalOnDisk(): unknown {
  return JSON.parse(readFileSync(join(cwd, RENAME_JOURNAL_FILE), "utf8"))
}

describe("the journal file", () => {
  it("is supatype/renames.json, versioned, and absent until a rename is recorded", () => {
    expect(RENAME_JOURNAL_FILE).toBe("supatype/renames.json")
    expect(readRenameJournal(cwd)).toEqual({ version: 1, renames: [] })
  })

  it("records who declared a rename and when, with an id", () => {
    const entry = appendRename(cwd, column, "Ada Lovelace <ada@example.com>", at)
    expect(entry).toMatchObject({
      kind: "column",
      table: "member",
      from: "name",
      to: "title",
      declared_by: "Ada Lovelace <ada@example.com>",
      declared_at: "2026-10-12T10:00:00.000Z",
    })
    expect(entry.id).toMatch(/^[0-9a-f-]{8,}$/)
    expect(journalOnDisk()).toEqual({ version: 1, renames: [entry] })
  })

  it("records the same rename once", () => {
    const first = appendRename(cwd, column, "Ada", at)
    const again = appendRename(cwd, column, "Grace", new Date("2026-10-13T00:00:00Z"))
    expect(again).toEqual(first)
    expect(readRenameJournal(cwd).renames).toHaveLength(1)
  })

  it("refuses a journal written by a newer CLI rather than dropping what it holds", () => {
    mkdirSync(join(cwd, "supatype"), { recursive: true })
    writeFileSync(join(cwd, RENAME_JOURNAL_FILE), JSON.stringify({ version: 2, renames: [] }))
    expect(() => readRenameJournal(cwd)).toThrow(/version 2/)
  })

  it("refuses a malformed journal, naming the file", () => {
    mkdirSync(join(cwd, "supatype"), { recursive: true })
    writeFileSync(join(cwd, RENAME_JOURNAL_FILE), JSON.stringify({ version: 1, renames: [{ kind: "column" }] }))
    expect(() => readRenameJournal(cwd)).toThrow(/renames\.json/)
  })

  it("is what the writer handed to the push writes to", async () => {
    await journalRenameWriter(cwd, () => "Ada <ada@example.com>").write(column)
    expect(readRenameJournal(cwd).renames[0]).toMatchObject({ ...column, declared_by: "Ada <ada@example.com>" })
  })
})

function schemaAst(): ExtractedSchemaAstV2 {
  return {
    astVersion: 2,
    models: [
      {
        name: "member",
        fields: { id: { kind: "uuid", primaryKey: true }, title: { kind: "text" } },
        options: {},
        annotations: { db: { tableName: "member", indexes: [] }, platform: { access: {} } },
      },
    ],
  }
}

function entry(partial: Partial<RenameJournalEntry>): RenameJournalEntry {
  return {
    id: "r",
    kind: "column",
    table: "member",
    from: "name",
    to: "title",
    declared_by: "Ada",
    declared_at: at.toISOString(),
    ...partial,
  }
}

describe("withRenameJournal()", () => {
  it("carries the journal for the engine to read, and leaves the schema's fields alone", () => {
    const journal = { version: 1 as const, renames: [entry({}), entry({ from: "title", to: "headline" })] }
    const ast = withRenameJournal(schemaAst(), journal)
    expect(ast.renameJournal).toEqual(journal.renames)
    expect(ast.models).toEqual(schemaAst().models)
  })

  it("adds nothing for an empty journal, and does not change the AST it was given", () => {
    const before = schemaAst()
    expect(withRenameJournal(before, { version: 1, renames: [] })).not.toHaveProperty("renameJournal")
    withRenameJournal(before, { version: 1, renames: [entry({})] })
    expect(before).toEqual(schemaAst())
  })
})

describe("renameLabel()", () => {
  it("names a column on its table, and a table by its names", () => {
    expect(renameLabel(column)).toBe("member.name -> title")
    expect(renameLabel({ kind: "table", table: "member", from: "member", to: "members" })).toBe(
      "table member -> members",
    )
  })
})

describe("pruning", () => {
  const applied = [
    { name: "push_1", status: "applied", rolledBack: false, renames: [{ kind: "column" as const, table: "member", from: "name", to: "title" }] },
    { name: "push_2", status: "applied", rolledBack: true, renames: [{ kind: "table" as const, table: "a", from: "a", to: "b" }] },
    { name: "push_3", status: "failed", rolledBack: false, renames: [{ kind: "table" as const, table: "c", from: "c", to: "d" }] },
  ]

  it("reads the renames a database applied from its history, leaving out rolled back and failed pushes", () => {
    expect(appliedRenames(applied)).toEqual([{ kind: "column", table: "member", from: "name", to: "title" }])
  })

  it("removes only the entries the database applied", () => {
    const kept = entry({ id: "k", from: "a", to: "b" })
    const gone = entry({ id: "g" })
    const result = pruneJournal({ version: 1, renames: [gone, kept] }, appliedRenames(applied))
    expect(result.removed).toEqual([gone])
    expect(result.journal).toEqual({ version: 1, renames: [kept] })
  })

  it("keeps an entry a rolled back push applied", () => {
    const table = entry({ kind: "table", table: "a", from: "a", to: "b" })
    expect(pruneJournal({ version: 1, renames: [table] }, appliedRenames(applied)).removed).toEqual([])
  })
})
