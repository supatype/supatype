/**
 * Ask a scaffolded project to generate types.
 *
 * `supatype init` configures no `output.types`, so nothing is generated and the conformance check
 * that the TypeScript matches the column has nothing to read.
 *
 * Its own file rather than a `node -e` in the runner: quoting a JavaScript string containing
 * TypeScript object syntax through bash mangled it into a syntax error, and the next person to
 * edit it would hit the same wall.
 */
import { readFileSync, writeFileSync } from "node:fs"

const path = process.argv[2]
if (!path) {
  console.error("usage: enable-types.mjs <supatype.config.ts>")
  process.exit(1)
}

const source = readFileSync(path, "utf8")
if (source.includes("output:")) {
  console.log("  output.types already configured")
  process.exit(0)
}

const anchor = /(\n\s*project:\s*\{[^}]*\},)/
if (!anchor.test(source)) {
  console.error("  could not find the project block to insert after")
  process.exit(1)
}

const patched = source.replace(
  anchor,
  '$1\n  output: { types: "supatype/generated/database.ts" },',
)
writeFileSync(path, patched, "utf8")
console.log("  output.types set to supatype/generated/database.ts")
