import { describe, expect, it } from "vitest"
import { sqlEditorOffered } from "../src/lib/sql-editor-access.js"
import { databaseSectionFor } from "../src/components/SecondaryPanel.js"
import { jumpTargetsFor } from "../src/components/JumpToSearch.js"

/**
 * RX1: the SQL editor keeps full access (it runs as the project's owning role, so row level
 * security does not apply) and is for owners, admins and developers. Editors, billing members and
 * viewers are not offered it on either host: the server refuses their queries, so a nav entry would
 * lead to an editor that cannot run anything.
 */

const as = (role: string | null, sqlEditor: boolean | undefined) => ({
  role,
  permissions: sqlEditor === undefined ? {} : { sqlEditor },
})

function labels(section: ReturnType<typeof databaseSectionFor>): string[] {
  return section.groups.flatMap((g) => g.items.map((i) => i.label))
}

describe("the SQL editor", () => {
  it("is offered to roles holding sqlEditor, and until the capability resolves", () => {
    expect(sqlEditorOffered(as("developer", true))).toBe(true)
    expect(sqlEditorOffered(as(null, undefined))).toBe(true)
  })

  it("is not offered to editors, billing members or viewers", () => {
    for (const role of ["editor", "billing", "viewer"]) expect(sqlEditorOffered(as(role, false))).toBe(false)
  })

  it("leaves the Database nav without SQL Runner for them, and keeps it for developers", () => {
    expect(labels(databaseSectionFor(as("viewer", false)))).not.toContain("SQL Runner")
    expect(labels(databaseSectionFor(as("developer", true)))).toContain("SQL Runner")
  })

  it("is not a jump target for them", () => {
    const targets = (role: string, sqlEditor: boolean) => jumpTargetsFor(as(role, sqlEditor)).map((t) => t.label)
    expect(targets("editor", false)).not.toContain("SQL Runner")
    expect(targets("admin", true)).toContain("SQL Runner")
  })
})
