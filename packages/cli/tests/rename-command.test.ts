import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * `supatype rename <table>.<from> <table>.<to>`: what a terminal's "yes" records, for CI and agents,
 * which have no terminal to ask on. A push off a terminal names this command when it is refused.
 * `--prune` removes what the target database reports as applied, and nothing else.
 */

const lines: string[] = []
vi.mock("../src/ui/messages.js", () => ({
  info: (line: string) => lines.push(line),
  plain: (line?: string) => lines.push(line ?? ""),
  warn: (line: string) => lines.push(`warn: ${line}`),
  success: (line: string) => lines.push(line),
}))

const { parseRenameArgs, recordRename, pruneRenames } = await import("../src/commands/rename.js")
const { readRenameJournal, renameCommandHint } = await import("../src/rename-journal.js")

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "rename-command-"))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
  lines.length = 0
})

describe("parseRenameArgs()", () => {
  it("reads <table>.<from> <table>.<to> as a column rename", () => {
    expect(parseRenameArgs("member.name", "member.title")).toEqual({
      kind: "column",
      table: "member",
      from: "name",
      to: "title",
    })
  })

  it("reads two bare names as a table rename", () => {
    expect(parseRenameArgs("member", "members")).toEqual({
      kind: "table",
      table: "member",
      from: "member",
      to: "members",
    })
  })

  it("refuses a column moved between tables, a mix of the two forms, and a no-op", () => {
    expect(() => parseRenameArgs("member.name", "team.name")).toThrow(/same table/)
    expect(() => parseRenameArgs("member.name", "title")).toThrow(/<table>\.<column>/)
    expect(() => parseRenameArgs("member.name", "member.name")).toThrow(/same name/)
    expect(() => parseRenameArgs("a.b.c", "a.b.d")).toThrow(/<table>\.<column>/)
  })

  it("is what a refused push names, for each candidate", () => {
    expect(renameCommandHint({ kind: "column", table: "member", from: "name", to: "title" })).toBe(
      "supatype rename member.name member.title",
    )
    expect(renameCommandHint({ kind: "table", table: "member", from: "member", to: "members" })).toBe(
      "supatype rename member members",
    )
  })
})

describe("recordRename()", () => {
  it("writes the journal entry with who declared it", () => {
    recordRename(cwd, parseRenameArgs("member.name", "member.title"), "Ada <ada@example.com>")
    expect(readRenameJournal(cwd).renames).toEqual([
      expect.objectContaining({ kind: "column", table: "member", from: "name", to: "title", declared_by: "Ada <ada@example.com>" }),
    ])
    expect(lines.join("\n")).toContain("supatype/renames.json")
  })
})

describe("pruneRenames()", () => {
  it("removes what the database applied and says what it kept", async () => {
    recordRename(cwd, parseRenameArgs("member.name", "member.title"), "Ada")
    recordRename(cwd, parseRenameArgs("member", "members"), "Ada")
    const list = async () => [
      { name: "push_1", status: "applied", rolledBack: false, renames: [{ kind: "column" as const, table: "member", from: "name", to: "title" }] },
    ]
    const removed = await pruneRenames(cwd, list)
    expect(removed).toBe(1)
    expect(readRenameJournal(cwd).renames.map((r) => r.kind)).toEqual(["table"])
    expect(lines.join("\n")).toContain("1 rename(s) kept")
  })

  it("removes nothing when the history has no record of renames", async () => {
    recordRename(cwd, parseRenameArgs("member.name", "member.title"), "Ada")
    expect(await pruneRenames(cwd, async () => [{ name: "push_1", status: "applied", rolledBack: false }])).toBe(0)
    expect(readRenameJournal(cwd).renames).toHaveLength(1)
  })
})
