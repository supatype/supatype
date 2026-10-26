/**
 * Point a scaffolded project's generated types at the file the conformance check reads.
 *
 * verify.ts reads `supatype/generated/database.ts`. `supatype init` used to configure no
 * `output` at all, and now writes one with the default `types/database.ts` (H7). Either way the
 * types path is set here to the one the check reads: skipping a project that already had an
 * `output` section left the check reading a file nothing wrote.
 *
 * Its own file rather than a `node -e` in the runner: quoting a JavaScript string containing
 * TypeScript object syntax through bash mangled it into a syntax error, and the next person to
 * edit it would hit the same wall.
 */
import { readFileSync, writeFileSync } from "node:fs"

const TYPES = "supatype/generated/database.ts"

const path = process.argv[2]
if (!path) {
  console.error("usage: enable-types.mjs <supatype.config.ts>")
  process.exit(1)
}

const source = readFileSync(path, "utf8")

/** Sets `types` inside an existing `output: { ... }`, or inserts the section after `project`. */
function withTypesPath(text) {
  const output = /(\n\s*output:\s*\{)([^}]*)(\})/
  if (output.test(text)) {
    return text.replace(output, (_all, open, body, close) => {
      const rest = body.replace(/\s*types:\s*"[^"]*",?/, "").trim()
      return `${open} types: "${TYPES}"${rest === "" ? " " : `, ${rest.replace(/^,\s*/, "")} `}${close}`
    })
  }
  const project = /(\n\s*project:\s*\{[^}]*\},)/
  if (!project.test(text)) return undefined
  return text.replace(project, `$1\n  output: { types: "${TYPES}" },`)
}

const patched = withTypesPath(source)
if (patched === undefined) {
  console.error("  could not find an output section or the project block to insert after")
  process.exit(1)
}
writeFileSync(path, patched, "utf8")
console.log(`  output.types set to ${TYPES}`)
