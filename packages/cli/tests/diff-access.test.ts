import { afterEach, describe, expect, it, vi } from "vitest"
import { formatRoleAccess, printRoleAccess } from "../src/diff-access.js"
import { isDiffResult } from "../src/engine-answers.js"
import type { RoleAccess } from "../src/engine-client.js"

function entry(table: string, role: string, before: string[], after: string[]): RoleAccess {
  return { model: table, table, role, before, after }
}

/** The formflow shape once pushed: form readable when published, a respondent's question and response. */
const FORMFLOW: RoleAccess[] = [
  entry("form", "anon", ["read"], ["read"]),
  entry("form", "authenticated", ["read", "create", "update", "delete"], ["read", "create", "update", "delete"]),
  entry("question", "anon", ["read"], ["read"]),
  entry("question", "authenticated", ["read", "create", "update", "delete"], ["read", "create", "update", "delete"]),
  entry("response", "anon", ["create"], ["create"]),
  entry("response", "authenticated", ["read", "create", "delete"], ["read", "create", "delete"]),
  entry("profile", "anon", [], []),
  entry("profile", "authenticated", ["read", "create", "update", "delete"], ["read", "create", "update", "delete"]),
]

describe("formatRoleAccess()", () => {
  it("lists what anon may do on each model's table, signed out, with the names aligned", () => {
    expect(formatRoleAccess(FORMFLOW)).toEqual([
      "Access for anon (signed out):",
      "  form       read",
      "  question   read",
      "  response   create",
      "  profile    none",
      "",
      "Access for authenticated (signed in):",
      "  form       read, create, update, delete",
      "  question   read, create, update, delete",
      "  response   read, create, delete",
      "  profile    read, create, update, delete",
    ])
  })

  it("marks a line whose access the push changes with what it is now", () => {
    const access = [
      entry("question", "anon", [], ["read"]),
      entry("response", "anon", ["create"], []),
      entry("form", "anon", ["read"], ["read"]),
    ]
    expect(formatRoleAccess(access)).toEqual([
      "Access for anon (signed out):",
      "  question   none -> read",
      "  response   create -> none",
      "  form       read",
    ])
  })

  it("does not call a change of order a change", () => {
    expect(formatRoleAccess([entry("form", "anon", ["create", "read"], ["read", "create"])])).toEqual([
      "Access for anon (signed out):",
      "  form   read, create",
    ])
  })

  it("is nothing when the engine sent no access", () => {
    expect(formatRoleAccess([])).toEqual([])
  })
})

describe("printRoleAccess()", () => {
  afterEach(() => vi.restoreAllMocks())

  it("prints the block, and nothing for an engine older than the summary", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    printRoleAccess({ access: [entry("question", "anon", [], ["read"])] })
    printRoleAccess({})
    expect(log.mock.calls.map((call) => call.join(" "))).toEqual([
      "Access for anon (signed out):\n  question   none -> read\n",
    ])
  })
})

describe("isDiffResult()", () => {
  it("accepts a plan that carries each role's access, and one without it", () => {
    expect(isDiffResult({ operations: [], access: FORMFLOW })).toBe(true)
    expect(isDiffResult({ operations: [] })).toBe(true)
  })

  it("refuses an access entry that is not the engine's shape", () => {
    expect(isDiffResult({ operations: [], access: [{ table: "form", role: "anon", after: "read" }] })).toBe(false)
  })
})

describe("supatype diff output", () => {
  afterEach(() => vi.restoreAllMocks())

  it("ends with each role's access, after a blank line, also when nothing changes", async () => {
    const { printDiff } = await import("../src/commands/diff.js")
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    printDiff({ operations: [], access: [entry("question", "anon", ["read"], ["read"])] })
    expect(log.mock.calls.map((call) => call.join(" ")).join("\n")).toBe(
      "No changes.\n\nAccess for anon (signed out):\n  question   read\n",
    )
  })
})

describe("formatRoleAccess() for many-to-many links", () => {
  const READS_LINK = "an end's read rule reads this link table"

  it("marks a junction as a link and says what it denies and why", () => {
    const access: RoleAccess[] = [
      entry("post", "anon", ["read"], ["read"]),
      { ...entry("post_tags", "anon", ["read"], ["read"]), link: true },
      {
        ...entry("project_members", "anon", [], []),
        link: true,
        denied: { verbs: ["read"], reason: READS_LINK },
      },
    ]
    expect(formatRoleAccess(access)).toEqual([
      "Access for anon (signed out):",
      "  post                     read",
      "  post_tags (link)         read",
      `  project_members (link)   none   (read denied: ${READS_LINK})`,
    ])
  })

  it("lists every verb a link denies", () => {
    const link: RoleAccess = {
      ...entry("tags_links", "authenticated", [], []),
      link: true,
      denied: { verbs: ["read", "delete"], reason: READS_LINK },
    }
    expect(formatRoleAccess([link])).toEqual([
      "Access for authenticated (signed in):",
      `  tags_links (link)   none   (read, delete denied: ${READS_LINK})`,
    ])
  })
})

describe("formatRoleAccess() with changedOnly, as supatype dev prints it", () => {
  it("keeps only the lines whose access changes, under their role", () => {
    const access = [
      entry("form", "anon", ["read"], ["read"]),
      entry("question", "anon", [], ["read"]),
      entry("form", "authenticated", ["read"], ["read"]),
    ]
    expect(formatRoleAccess(access, { changedOnly: true })).toEqual([
      "Access for anon (signed out):",
      "  question   none -> read",
    ])
  })

  it("is nothing when no line changes", () => {
    expect(formatRoleAccess(FORMFLOW, { changedOnly: true })).toEqual([])
  })
})

describe("isDiffResult() with links", () => {
  it("accepts a link with what it denies, and refuses a denial without its reason", () => {
    const link = { ...entry("post_tags", "anon", [], []), link: true, denied: { verbs: ["read"], reason: "x" } }
    expect(isDiffResult({ operations: [], access: [link] })).toBe(true)
    const bad = { ...link, denied: { verbs: ["read"] } }
    expect(isDiffResult({ operations: [], access: [bad] })).toBe(false)
  })
})

describe("reportAppliedPush()", () => {
  afterEach(() => vi.restoreAllMocks())

  it("prints the access lines the push changed, and none when quiet or when nothing changed", async () => {
    const { reportAppliedPush } = await import("../src/engine-push-output.js")
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const access = [entry("form", "anon", ["read"], ["read"]), entry("question", "anon", [], ["read"])]
    reportAppliedPush({ status: "applied", message: "Applied 3 operation(s).", access })
    const changed = log.mock.calls.map((call) => call.join(" ")).join("\n")
    expect(changed).toContain("Access for anon (signed out):\n  question   none -> read")
    expect(changed).not.toContain("form")

    log.mockClear()
    reportAppliedPush({ status: "applied", message: "Applied 3 operation(s).", access }, "quiet")
    reportAppliedPush({ status: "applied", message: "Applied 1 operation(s).", access: FORMFLOW })
    expect(log.mock.calls.map((call) => call.join(" ")).join("\n")).not.toContain("Access for")
  })
})
