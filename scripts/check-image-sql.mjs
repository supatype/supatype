#!/usr/bin/env node
/**
 * Checks the SQL native dev copies from the supatype/postgres image against a supatype-postgres
 * checkout: each vendored file in packages/cli/tests/fixtures/image-sql must still match its source
 * (LF-normalised sha256), and each copied line must still be at its line. Exits 1 naming each one
 * that drifted, so whichever repo changed can update the other.
 *
 * In this repo the gate is packages/cli/tests/native-image-sql.test.ts, which runs with the CLI's
 * tests: the CLI's SQL against the vendored copies, and the copies against their recorded sha256.
 * This script is the other half, for wherever both repos are checked out, the supatype-postgres
 * CI included: `node scripts/check-image-sql.mjs <path to supatype-postgres>`, or
 * `pnpm check:image-sql` with SUPATYPE_POSTGRES_REPO set. With no checkout it says so and exits 0.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repo = process.argv[2] ?? process.env.SUPATYPE_POSTGRES_REPO ?? ""
if (repo === "" || !existsSync(repo)) {
  console.log(`Image SQL check skipped: no supatype-postgres checkout${repo ? ` at ${repo}` : " given"}.`)
  process.exit(0)
}
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "tests", "fixtures", "image-sql")
const sources = JSON.parse(readFileSync(join(fixtures, "sources.json"), "utf8"))
const text = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")
const sha = (content) => createHash("sha256").update(content).digest("hex")

const drifted = []
for (const file of sources.files) {
  const actual = sha(text(join(repo, file.source)))
  if (actual !== file.sha256) drifted.push(`${file.source}: sha256 ${actual}, recorded ${file.sha256}`)
}
for (const copied of sources.lines) {
  const actual = text(join(repo, copied.source)).split("\n")[copied.line - 1]
  if (actual !== copied.text) drifted.push(`${copied.source}:${copied.line}: ${JSON.stringify(actual)}, copied ${JSON.stringify(copied.text)}`)
}
if (drifted.length > 0) {
  console.error(`Image SQL native dev copies has changed in ${repo}:\n${drifted.map((d) => `  ${d}`).join("\n")}`)
  process.exit(1)
}
console.log("Native dev's copies of the image SQL match.")
