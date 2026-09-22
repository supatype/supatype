#!/usr/bin/env node
/**
 * Which public surfaces the examples exercise, and which nobody has ever used.
 *
 * "The examples cover everything" is a claim that decays the day after someone checks it. This
 * makes it checkable: every name a package exports is either imported by an example, or listed
 * below with a reason. A new export with no example fails this, which is the point — the gap is
 * found when it is cheap, by whoever added it.
 *
 * **Imports, not grep.** Matching a bare word would count `Optional` in a comment and miss
 * `client.storage.from(...)` entirely. This reads each example's import statements and records
 * which names it took from which package, so the answer is what the example actually binds.
 *
 * That means the ledger is honest about one thing and blind to another: a name imported and never
 * called still counts as covered. Catching that needs the example to be *run*, which is what the
 * live-stack jobs in tests/integration/scripts are for. Two different questions, two mechanisms.
 *
 * **It reports; it does not gate on completeness.** An earlier cut failed the build on any export
 * no example imported, and two thirds of that list was noise: option and return types you receive
 * structurally rather than import (`UseQueryOptions`), classes you get off the client rather than
 * construct (`BucketClient`), utilities exported for tests (`fetchWithRetry`). Worse, demanding an
 * example for every exotic primitive would force exactly the forty-field `Kitchen` model the
 * kitchen sink argues against — a field has to have an honest reason to exist.
 *
 * What *is* gated is that this file's output stays current: CI regenerates `examples/COVERAGE.md`
 * and fails if it differs from what is committed. Add an export and the numbers move, so the gap
 * arrives in a diff, in review, where a person decides whether it deserves an example.
 *
 *   node scripts/check-example-coverage.mjs           # print the summary
 *   node scripts/check-example-coverage.mjs --write   # rewrite examples/COVERAGE.md
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")

/**
 * Packages a user imports. Deliberately not every workspace package: `@supatype/studio` is an app,
 * `@supatype/realtime` is a service, and neither is something an example would import.
 */
const PUBLIC_PACKAGES = [
  "types", "client", "react", "ssr", "react-auth",
  "react-native", "react-native-auth", "vue", "svelte", "solid",
  "plugin-sdk",
]

/**
 * Names you never import: they arrive as an argument's type, a return value, or an instance off the
 * client. Counting them as uncovered surface buries the names that matter.
 */
const ANCILLARY = /(?:Props|Options|Option|Result|Return|Config|Entry|Def|Doc|Documentation|Meta|Adapter|Labels|Status|Event|Error|Client|Builder|Cache|Database|Fields?|Type)$/

/** Exported for tests or internal use rather than for a caller to reach for. */
const INTERNAL = /^(?:createRetryFetch|fetchWithRetry|warnIfServerlessDirectConnection|detectServerlessEnvironment|getErrorCodesByCategory|getErrorDocumentation|defaultQueryCache|createCodeChallengeS256|generateCodeVerifier)$/

/** SCREAMING_CASE exports are documentation constants, not a surface an example demonstrates. */
const CONSTANT = /^[A-Z0-9_]+$/

/**
 * Notes carried into the report. A line here is a decision someone made, not a shrug: it says the
 * gap is known and names what closing it would take. Delete the line when an example covers it.
 */
const ALLOWLIST = {
  "@supatype/vue": "no example: the Vue bindings want a parity example alongside svelte and solid",
  "@supatype/svelte": "no example: see @supatype/vue",
  "@supatype/solid": "no example: see @supatype/vue",
  "@supatype/plugin-sdk": "no example: schema-side plugin registration needs a spike first",
  "@supatype/react-native": "covered by examples/expo-auth, which imports a subset",
  "@supatype/react-native-auth": "covered by examples/expo-auth, which imports a subset",
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === ".supatype") continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(ts|tsx|mts)$/.test(entry) && !path.includes("/generated/")) out.push(path)
  }
  return out
}

/** Every name a package's entry point exports. */
function exportsOf(pkg) {
  const entry = join(ROOT, "packages", pkg, "src", "index.ts")
  let source
  try {
    source = readFileSync(entry, "utf8")
  } catch {
    return []
  }
  const names = new Set()
  // `export type X =`, `export function x`, `export class X`, `export const x`
  for (const m of source.matchAll(/^export\s+(?:declare\s+)?(?:type|interface|function|class|const)\s+([A-Za-z0-9_]+)/gm)) {
    names.add(m[1])
  }
  // `export { a, b as c } from "./x.js"` and plain `export { a, b }`
  for (const m of source.matchAll(/^export\s*(?:type\s*)?\{([^}]+)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name && /^[A-Za-z0-9_]+$/.test(name)) names.add(name)
    }
  }
  return [...names]
    .filter((n) => !ANCILLARY.test(n) && !INTERNAL.test(n) && !CONSTANT.test(n))
    .sort()
}

/** What each example imports, by package. */
function importsByExample() {
  const found = new Map() // "@supatype/x" -> Map<name, Set<example>>
  for (const file of walk(join(ROOT, "examples"))) {
    const example = relative(join(ROOT, "examples"), file).split("/")[0]
    const source = readFileSync(file, "utf8")
    for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s*from\s*["'](@supatype\/[a-z-]+)["']/g)) {
      const pkg = m[2]
      if (!found.has(pkg)) found.set(pkg, new Map())
      const names = found.get(pkg)
      for (const part of m[1].split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim()
        if (!name || !/^[A-Za-z0-9_]+$/.test(name)) continue
        if (!names.has(name)) names.set(name, new Set())
        names.get(name).add(example)
      }
    }
  }
  return found
}

const used = importsByExample()
const rows = []
const uncovered = []

for (const pkg of PUBLIC_PACKAGES) {
  const spec = `@supatype/${pkg}`
  const exported = exportsOf(pkg)
  if (exported.length === 0) continue
  const usedNames = used.get(spec) ?? new Map()
  const covered = exported.filter((n) => usedNames.has(n))
  const missing = exported.filter((n) => !usedNames.has(n))

  rows.push({ spec, total: exported.length, covered: covered.length, missing })
  if (missing.length > 0 && ALLOWLIST[spec] === undefined) {
    uncovered.push({ spec, missing })
  }
}

const lines = [
  "# Example coverage",
  "",
  "Generated by `scripts/check-example-coverage.mjs`. Do not edit by hand.",
  "",
  "What each public package exports, and how much of it an example imports. A name imported and",
  "never called still counts here: proving an example *runs* is what the live-stack jobs in",
  "`tests/integration/scripts` are for.",
  "",
  "| Package | Exports | Imported by an example | Note |",
  "|---|---:|---:|---|",
]
for (const row of rows) {
  const note = ALLOWLIST[row.spec] ?? (row.missing.length === 0 ? "complete" : `${row.missing.length} not imported`)
  lines.push(`| \`${row.spec}\` | ${row.total} | ${row.covered} | ${note} |`)
}
lines.push(
  "",
  "## Names no example imports",
  "",
  "Ancillary types (`…Options`, `…Result`), client-owned classes and test-only utilities are",
  "excluded — you receive those rather than reaching for them. What is left is vocabulary: each",
  "either deserves an example or deserves saying why not.",
  "",
)
for (const row of rows) {
  if (row.missing.length === 0) continue
  lines.push(`**\`${row.spec}\`** — ${row.missing.map((n) => `\`${n}\``).join(", ")}`, "")
}

const report = lines.join("\n") + "\n"
if (process.argv.includes("--write")) {
  writeFileSync(join(ROOT, "examples", "COVERAGE.md"), report)
  console.log("wrote examples/COVERAGE.md")
}

for (const row of rows) {
  const note = ALLOWLIST[row.spec] ? ` (allowlisted: ${ALLOWLIST[row.spec]})` : ""
  console.log(`${String(row.covered).padStart(3)}/${String(row.total).padEnd(3)} ${row.spec}${note}`)
}

if (uncovered.length > 0) {
  console.log("")
  for (const { spec, missing } of uncovered) {
    console.log(`${spec}: ${missing.length} name(s) no example imports`)
    console.log(`  ${missing.join(", ")}`)
  }
  console.log("")
  console.log("Not a failure: whether each deserves an example is a judgement, and it belongs in")
  console.log("review. CI fails only if examples/COVERAGE.md is out of date with this output.")
}
