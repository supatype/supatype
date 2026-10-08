import { afterEach, describe, expect, it, vi } from "vitest"
import {
  formatSecurityDrift,
  isRisky,
  plannedChanges,
  printDiffOperations,
  securityDrift,
} from "../src/diff-output.js"
import { endpointToArgs, type DiffResult, type ReconcileAction } from "../src/engine-client.js"

function key(kind: string, parent: string, name: string): ReconcileAction["key"] {
  return { kind, schema: "public", parent, name }
}

function printed(run: () => void): string {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  run()
  return log.mock.calls.map((call) => call.join(" ")).join("\n")
}

describe("plannedChanges()", () => {
  it("lists the differ's operations and then the reconcile's changes", () => {
    const diff: DiffResult = {
      operations: [{ type: "add_column", table: "posts", column: "title", risk: "safe" }],
      reconcile: [
        { action: "replace", key: key("check", "posts", "posts_title_bounds") },
        { action: "keep", key: key("check", "posts", "posts_status_check") },
      ],
    }
    expect(plannedChanges(diff).map((c) => c.label)).toEqual([
      "add_column posts.title",
      "replace check posts.posts_title_bounds",
    ])
  })

  it("leaves out what changes nothing in the database", () => {
    const diff: DiffResult = {
      operations: [],
      reconcile: [
        { action: "keep", key: key("check", "posts", "a") },
        { action: "forget", key: key("check", "posts", "b") },
        { action: "released", key: key("check", "posts", "c") },
        { action: "create", key: key("check", "posts", "d"), inline: true },
      ],
    }
    expect(plannedChanges(diff)).toEqual([])
  })

  it("rates a conflict and security-relevant drift as dangerous, hand changes as caution", () => {
    const diff: DiffResult = {
      operations: [],
      reconcile: [
        { action: "conflict", key: key("foreign_key", "posts", "posts_author_id_fkey") },
        { action: "drift", key: key("policy", "posts", "posts_select"), security_relevant: true },
        { action: "drift", key: key("check", "posts", "posts_title_bounds"), security_relevant: false },
        { action: "recreate", key: key("check", "posts", "posts_price_check") },
        { action: "drop", key: key("foreign_key", "posts", "posts_editor_id_fkey") },
        { action: "adopt", key: key("foreign_key", "posts", "posts_owner_id_fkey"), reason: "structure_matches" },
      ],
    }
    expect(plannedChanges(diff).map((c) => [c.label, c.risk])).toEqual([
      [
        "foreign key posts.posts_author_id_fkey exists and was not created by Supatype; run `supatype adopt` or rename it",
        "danger",
      ],
      ["policy posts.posts_select was changed outside Supatype; the push puts it back", "danger"],
      ["check posts.posts_title_bounds was changed outside Supatype; the push puts it back", "cautious"],
      ["recreate check posts.posts_price_check (dropped outside Supatype)", "cautious"],
      ["drop foreign key posts.posts_editor_id_fkey", "cautious"],
      ["adopt foreign key posts.posts_owner_id_fkey (already in the database, now recorded as Supatype's)", "safe"],
    ])
  })

  it("leaves out every action its parent statement carries out, not only a create", () => {
    const diff: DiffResult = {
      operations: [{ type: "create_table", table: "posts", risk: "safe" }],
      reconcile: [
        { action: "recreate", key: key("check", "posts", "a"), inline: true },
        { action: "replace", key: key("check", "posts", "b"), inline: true },
        { action: "drift", key: key("check", "posts", "c"), inline: true, security_relevant: false },
        { action: "create", key: key("foreign_key", "posts", "d"), inline: true },
      ],
    }
    const changes = plannedChanges(diff)
    expect(changes.map((c) => c.label)).toEqual(["create_table posts"])
    // Nothing left to confirm: a CI push without --yes must not abort on an inline recreate.
    expect(changes.filter(isRisky)).toEqual([])
  })

  it("names an object without a parent by its name alone", () => {
    const diff: DiffResult = {
      operations: [],
      reconcile: [{ action: "create", key: key("enum_type", "", "mood"), inline: false }],
    }
    expect(plannedChanges(diff).map((c) => c.label)).toEqual(["create enum type mood"])
  })

  it("is the differ's operations alone for an engine without a reconcile", () => {
    const diff: DiffResult = { operations: [{ type: "create_table", table: "posts" }] }
    expect(plannedChanges(diff).map((c) => c.label)).toEqual(["create_table posts"])
  })
})

describe("printDiffOperations()", () => {
  afterEach(() => vi.restoreAllMocks())

  it("counts and prints the reconcile's changes with the operations", () => {
    const out = printed(() =>
      printDiffOperations({
        operations: [{ type: "add_column", table: "posts", column: "title", risk: "safe" }],
        reconcile: [{ action: "drop", key: key("check", "posts", "posts_title_bounds") }],
      }),
    )
    expect(out).toContain("2 change(s)")
    expect(out).toContain("[+] add_column posts.title  (safe)")
    expect(out).toContain("[~] drop check posts.posts_title_bounds  (caution)")
  })

  it("says so when neither has anything to do", () => {
    const out = printed(() =>
      printDiffOperations({ operations: [], reconcile: [{ action: "keep", key: key("check", "posts", "a") }] }),
    )
    expect(out).toContain("No changes.")
  })
})

describe("securityDrift()", () => {
  it("selects access changed or removed outside Supatype, and nothing else", () => {
    const reconcile: ReconcileAction[] = [
      {
        action: "drift",
        key: key("policy", "posts", "posts_select"),
        security_relevant: true,
        recorded_def: "using=true",
        live_def: "using=false",
      },
      { action: "recreate", key: key("table_grant", "posts", "anon"), create_sql: "GRANT" },
      { action: "drift", key: key("trigger", "posts", "t"), security_relevant: false },
      { action: "recreate", key: key("index", "posts", "i") },
    ]
    const drifted = securityDrift({ reconcile })
    expect(drifted.map((a) => a.key.kind)).toEqual(["policy", "table_grant"])
  })

  it("is empty for an engine without a reconcile", () => {
    expect(securityDrift({})).toEqual([])
  })
})

describe("formatSecurityDrift()", () => {
  it("shows what Supatype recorded beside what the database holds now", () => {
    const lines = formatSecurityDrift([
      {
        action: "drift",
        key: key("policy", "posts", "posts_select"),
        security_relevant: true,
        recorded_def: "using=true",
        live_def: "using=false",
      },
      { action: "recreate", key: key("table_grant", "posts", "anon"), create_sql: "GRANT SELECT" },
    ])
    expect(lines).toEqual([
      "  policy posts.posts_select",
      "    Supatype's:",
      "      using=true",
      "    Now:",
      "      using=false",
      "  table grant posts.anon",
      "    Supatype's:",
      "      GRANT SELECT",
      "    Now: removed",
    ])
  })
})

describe("endpointToArgs() for /push", () => {
  const body = { database_url: "postgres://x", force: true }

  it("passes --overwrite-drift only when consent was given", () => {
    expect(endpointToArgs("/push", body, "req.json")).not.toContain("--overwrite-drift")
    expect(endpointToArgs("/push", { ...body, overwrite_drift: true }, "req.json")).toContain(
      "--overwrite-drift",
    )
  })
})
