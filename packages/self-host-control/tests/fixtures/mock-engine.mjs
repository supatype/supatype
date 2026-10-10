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
  console.log(JSON.stringify({ features: ["adopt_keys", "adopt_none", "release", "reclaim", "rebaseline", "accept_access_drift", "overwrite_drift", "engine_busy"] }))
} else if (process.env["MOCK_ENGINE_REFUSE"] === "security_drift") {
  console.log(JSON.stringify({
    status: "refused",
    reason: "security_drift",
    objects: [{ key: { kind: "policy", schema: "public", parent: "posts", name: "read" }, recorded: "a", live: "b" }],
  }))
  console.error("2026-01-01T00:00:00Z  INFO supatype-engine starting")
  console.error("Error: 1 object(s) that decide who may read or write were changed outside Supatype: policy:posts.read (changed).")
  process.exit(1)
} else if (process.env["MOCK_ENGINE_REFUSE"] === "engine_busy") {
  console.error("2026-01-01T00:00:00Z  INFO supatype-engine starting")
  console.error("Error: another push, adopt or rebaseline is running on this database; try again. Nothing was applied.")
  process.exit(1)
} else {
  // What it was asked, so a test can see every flag the control plane forwarded.
  console.log(JSON.stringify({ args }))
}
