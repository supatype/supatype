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
} else {
  console.log("{}")
}
