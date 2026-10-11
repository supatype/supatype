#!/usr/bin/env bash
# Run every train suite (or the ones named), one after another, and summarise.
#
# Suites run serially: most bring up a full stack, and several share default ports. Each one is
# judged by run-suite.sh; this exits non-zero when any suite failed, and writes summary.md.
#
# Usage: bash scripts/release-train/run-all.sh <results-dir> [suite ...]
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
source "$SCRIPT_DIR/suites.sh"

RESULTS="${1:?results directory}"
shift
mkdir -p "$RESULTS"
suites=("$@")
[[ ${#suites[@]} -gt 0 ]] || suites=("${TRAIN_SUITES[@]}")

started=$SECONDS
for s in "${suites[@]}"; do
  bash "$SCRIPT_DIR/run-suite.sh" "$s" "$RESULTS" || true
done

node -e '
  const fs = require("fs"), path = require("path")
  const [dir, wall, ...suites] = process.argv.slice(1)
  const rows = suites.map((s) => {
    const file = path.join(dir, s, "result.json")
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { suite: s, verdict: "fail", seconds: 0, reasons: ["no result written"] }
  })
  const lines = ["| Suite | Verdict | Seconds | Why |", "|---|---|---|---|"]
  for (const r of rows) lines.push(`| ${r.suite} | ${r.verdict} | ${r.seconds} | ${r.reasons.join("; ").replace(/\|/g, "/")} |`)
  const failed = rows.filter((r) => r.verdict !== "pass").length
  lines.push("", `${rows.length - failed} of ${rows.length} suites passed in ${wall}s.`)
  fs.writeFileSync(path.join(dir, "summary.md"), lines.join("\n") + "\n")
  console.log(lines.join("\n"))
  process.exit(failed === 0 ? 0 : 1)
' "$RESULTS" "$((SECONDS - started))" "${suites[@]}"
