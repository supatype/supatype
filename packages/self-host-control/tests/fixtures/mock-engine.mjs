#!/usr/bin/env node
/** Mock supatype-engine for control-plane unit tests. */
const args = process.argv.slice(2)
const joined = args.join(" ")

function subcommand() {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--input" || a === "--database-url" || a === "--schema" || a === "--name") {
      i++
      continue
    }
    if (a.startsWith("--")) continue
    return a
  }
  return args[0]
}

const cmd = subcommand()

/**
 * CL3: a migration with no sources to return, or a rollback with nothing to undo. `MOCK_ENGINE_REFUSE`
 * names the reason; the engine prints it as a JSON line on stdout, with a sentence on stderr worded
 * unlike the one callers used to match, so a caller that still matched words would miss it.
 * `MOCK_ENGINE_WORDS_ONLY=1` is an engine from before the reasons: the old sentence on stderr alone.
 */
const nothingToReturn = {
  no_schema_snapshot: {
    now: "Migration 20240101_test recorded no schema sources to return",
    before: "Migration 20240101_test has no schema snapshot",
  },
  no_applied_migration: {
    now: "There is no applied migration to undo",
    before: "no_applied_migration: No applied migration to roll back",
  },
  no_rollback_sql: {
    now: "The latest migration recorded no undo SQL",
    before: "no_rollback_sql: Migration has no rollback SQL (metadata-only push?)",
  },
}
const refusal = nothingToReturn[process.env["MOCK_ENGINE_REFUSE"] ?? ""]
if (refusal !== undefined) {
  if (process.env["MOCK_ENGINE_WORDS_ONLY"] === "1") {
    console.error(`Error: ${refusal.before}`)
  } else {
    const reason = process.env["MOCK_ENGINE_REFUSE"]
    console.log(JSON.stringify({ status: "refused", reason, message: refusal.now }))
    console.error(`Error: ${refusal.now}`)
  }
  process.exit(1)
}

/**
 * `diff`: no changes, or the operations `MOCK_ENGINE_DIFF_OPS` holds as JSON. What it was given (argv and
 * `DATABASE_URL`) goes to the file `MOCK_DIFF_RECORD` names, so a test can see where the DSN went.
 */
if (cmd === "diff") {
  const record = process.env["MOCK_DIFF_RECORD"]
  if (record) {
    const { writeFileSync } = await import("node:fs")
    writeFileSync(record, JSON.stringify({ argv: args, databaseUrl: process.env["DATABASE_URL"] }))
  }
  console.log(JSON.stringify({ operations: JSON.parse(process.env["MOCK_ENGINE_DIFF_OPS"] ?? "[]"), warnings: [] }))
  process.exit(0)
}

/**
 * `seed`: records what it was given (argv, `DATABASE_URL`, each `--ir` file's text and path) in the
 * file `MOCK_SEED_RECORD` names, so a test can see them without the answer carrying a DSN.
 * `MOCK_SEED_MODE` picks the outcome: `fail1` and `fail2` print a JSON result and exit 1 or 2,
 * `crash` prints a DSN on stderr and exits 3, `nojson` prints no JSON, `sleep` waits
 * `MOCK_SEED_SLEEP_MS` before a normal answer.
 */
if (cmd === "seed") {
  const { readFileSync, writeFileSync } = await import("node:fs")
  const irPaths = args.flatMap((a, i) => (a === "--ir" ? [args[i + 1]] : []))
  const irs = irPaths.map((path) => ({ path, text: readFileSync(path, "utf8") }))
  const inputAt = args.indexOf("--input")
  const record = process.env["MOCK_SEED_RECORD"]
  if (record) {
    writeFileSync(record, JSON.stringify({
      argv: args,
      databaseUrl: process.env["DATABASE_URL"],
      irs,
      inputPath: inputAt === -1 ? null : args[inputAt + 1],
    }))
  }
  const mode = process.env["MOCK_SEED_MODE"] ?? ""
  if (mode === "sleep") await new Promise((r) => setTimeout(r, Number(process.env["MOCK_SEED_SLEEP_MS"] ?? "300")))
  if (mode === "crash") {
    console.error(`error: connection to ${process.env["DATABASE_URL"]} failed`)
    process.exit(3)
  }
  if (mode === "nojson") {
    console.log("seeded, trust me")
    process.exit(0)
  }
  if (args.includes("--status")) {
    console.log(JSON.stringify({ files: [{ file: "a.ts", appliedAt: "2026-01-01T00:00:00Z", status: "applied", durationMs: 3, drifted: false }] }))
    process.exit(0)
  }
  if (mode === "fail1") {
    console.log(JSON.stringify({ ok: false, error: { kind: "constraint", message: "duplicate key" } }))
    process.exit(1)
  }
  if (mode === "fail2") {
    console.log(JSON.stringify({ ok: false, error: { kind: "connection", message: "no route" } }))
    process.exit(2)
  }
  const files = irs.map(({ text }) => ({ file: JSON.parse(text).file, status: "applied", written: { posts: 2 } }))
  console.log(JSON.stringify({ ok: true, atomic: args.includes("--atomic"), files }))
  process.exit(0)
}

if (cmd === "migrations" && args.includes("--name")) {
  const nameIdx = args.indexOf("--name")
  const name = args[nameIdx + 1] ?? "unknown"
  console.log(JSON.stringify({
    name,
    schema_sources_base64: "ZGF0YQ==",
    schema_sources_manifest: { fileCount: 1, compressedBytes: 4 },
  }))
} else if (cmd === "migrations") {
  console.log(JSON.stringify([
    {
      id: 1,
      name: "20240101_test",
      hash: "abc",
      applied_at: "2024-01-01T00:00:00Z",
      rolled_back: false,
      engine_version: "0.1.0",
      status: "applied",
    },
  ]))
} else if (cmd === "rollback") {
  console.log(JSON.stringify({
    status: "rolled_back",
    name: "20240101_test",
    message: "Rolled back migration 20240101_test.",
  }))
} else if (cmd === "capabilities") {
  if (process.env["MOCK_ENGINE_NO_CAPABILITIES"] === "1") {
    console.error("error: unrecognized subcommand 'capabilities'")
    process.exit(2)
  }
  console.log(JSON.stringify({ features: ["adopt_keys", "adopt_none", "release", "reclaim", "rebaseline", "accept_access_drift", "overwrite_drift", "engine_busy", ...(process.env["MOCK_ENGINE_NO_AUDIT"] === "1" ? [] : ["push_audit"])] }))
} else if (process.env["MOCK_ENGINE_REFUSE"] === "security_drift") {
  console.log(JSON.stringify({
    status: "refused",
    reason: "security_drift",
    objects: [{ key: { kind: "policy", schema: "public", parent: "posts", name: "read" }, recorded: "a", live: "b" }],
  }))
  console.error("2026-01-01T00:00:00Z  INFO supatype-engine starting")
  console.error("Error: 1 object(s) that decide who may read or write were changed outside Supatype: policy:posts.read (changed).")
  process.exit(1)
} else if (process.env["MOCK_ENGINE_REFUSE"] === "drift_changed") {
  const message =
    "The drift changed after the preview, so nothing was rebaselined. Drifted since: policy:tag.tag_select. No longer drifted: none."
  console.log(JSON.stringify({ status: "refused", reason: "drift_changed", unseen: ["policy:tag.tag_select"], gone: [], message }))
  console.error(`Error: ${message}`)
  process.exit(1)
} else if (process.env["MOCK_ENGINE_REFUSE"] === "engine_busy") {
  console.error("2026-01-01T00:00:00Z  INFO supatype-engine starting")
  console.error("Error: another push, adopt or rebaseline is running on this database; try again. Nothing was applied.")
  process.exit(1)
} else {
  // What it was asked, so a test can see every flag the control plane forwarded.
  console.log(JSON.stringify({ args }))
}
