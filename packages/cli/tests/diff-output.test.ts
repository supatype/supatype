import { afterEach, describe, expect, it, vi } from "vitest"
import {
  formatDriftedObjects,
  formatSecurityDrift,
  isRisky,
  plannedChanges,
  printDiffOperations,
  securityDrift,
  securityDriftRefusal,
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

  it("counts access the schema changes too when it was also hand-edited (replace with drifted)", () => {
    const reconcile: ReconcileAction[] = [
      {
        action: "replace",
        key: key("policy", "posts", "posts_select"),
        create_sql: "CREATE POLICY new",
        drifted: { recorded_def: "using=true", live_def: "using=false", live_fp: "fp" },
      },
      // Replaced, but nobody touched it: an ordinary schema change.
      { action: "replace", key: key("policy", "posts", "posts_insert"), create_sql: "CREATE POLICY x" },
      // Hand-edited, but not access: put back without asking.
      {
        action: "replace",
        key: key("check", "posts", "c"),
        create_sql: "CHECK",
        drifted: { recorded_def: "a", live_def: "b" },
      },
    ]
    const drifted = securityDrift({ reconcile })
    expect(drifted.map((a) => a.key.name)).toEqual(["posts_select"])
    expect(formatSecurityDrift(drifted)).toEqual([
      "  policy posts.posts_select",
      "    Supatype's:",
      "      using=true",
      "    Now:",
      "      using=false",
    ])
  })
})

describe("securityDriftRefusal()", () => {
  it("reads the objects from the engine's JSON refusal line, among log lines", () => {
    const output = [
      "INFO supatype-engine starting",
      JSON.stringify({
        status: "refused",
        reason: "security_drift",
        objects: [
          { key: { kind: "policy", schema: "public", parent: "posts", name: "read" }, recorded: "USING (true)", live: "USING (false)" },
          { key: { kind: "table_grant", schema: "public", parent: "posts", name: "anon" }, recorded: "GRANT SELECT", live: null },
        ],
      }),
      "Error: 2 object(s) that decide who may read or write were changed outside Supatype",
    ].join("\n")
    const objects = securityDriftRefusal(output)
    expect(objects).toHaveLength(2)
    expect(formatDriftedObjects(objects!)).toEqual([
      "  policy posts.read",
      "    Supatype's:",
      "      USING (true)",
      "    Now:",
      "      USING (false)",
      "  table grant posts.anon",
      "    Supatype's:",
      "      GRANT SELECT",
      "    Now: removed",
    ])
  })

  it("is null for any other failure", () => {
    expect(securityDriftRefusal('{"status":"refused","reason":"unmanaged_model_tables","tables":["a"]}')).toBeNull()
    expect(securityDriftRefusal("Error: boom")).toBeNull()
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

describe("--overwrite-drift on every push path", () => {
  it("reaches the compose schema-engine only when asked", async () => {
    const { composeEnginePushArgs } = await import("../src/dev-compose.js")
    expect(composeEnginePushArgs("postgres://db", null)).not.toContain("--overwrite-drift")
    expect(composeEnginePushArgs("postgres://db", null, { overwriteDrift: false })).not.toContain(
      "--overwrite-drift",
    )
    const args = composeEnginePushArgs("postgres://db", null, { overwriteDrift: true })
    expect(args.slice(0, 1)).toEqual(["push"])
    expect(args).toContain("--overwrite-drift")
  })

  it("a deploy refuses security drift unless --overwrite-drift was passed", async () => {
    const { deploySecurityDriftRefusal } = await import("../src/commands/deploy.js")
    const diff: DiffResult = {
      operations: [],
      reconcile: [
        {
          action: "drift",
          key: key("policy", "posts", "posts_select"),
          security_relevant: true,
          recorded_def: "USING (true)",
          live_def: "USING (false)",
        },
      ],
    }
    const refusal = deploySecurityDriftRefusal(diff, false)
    expect(refusal).toContain("policy posts.posts_select")
    expect(refusal).toContain("pass --overwrite-drift")
    expect(deploySecurityDriftRefusal(diff, true)).toBeUndefined()
    expect(deploySecurityDriftRefusal({ reconcile: [] }, false)).toBeUndefined()
  })

  it("a deploy refuses a hand-edited policy the schema also replaces", async () => {
    const { deploySecurityDriftRefusal } = await import("../src/commands/deploy.js")
    const refusal = deploySecurityDriftRefusal(
      {
        reconcile: [
          {
            action: "replace",
            key: key("policy", "posts", "posts_select"),
            create_sql: "CREATE POLICY new",
            drifted: { recorded_def: "USING (true)", live_def: "USING (false)" },
          },
        ],
      },
      false,
    )
    expect(refusal).toContain("policy posts.posts_select")
    expect(refusal).toContain("USING (false)")
  })
})
