#!/usr/bin/env node
/**
 * A published package's CHANGELOG.md must not carry an "Unreleased" heading: that is what shipped
 * client 0.9.1's breaking changes with no version over them. The release workflow runs this before
 * anything publishes, so a tag cannot go out until each entry sits under the version it ships in.
 *
 *   node scripts/check-changelogs.mjs
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const packages = join(dirname(fileURLToPath(import.meta.url)), "..", "packages")
const published = readdirSync(packages).filter((name) => {
  const manifest = join(packages, name, "package.json")
  return existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).private !== true
})

const stale = published.filter((name) => {
  const changelog = join(packages, name, "CHANGELOG.md")
  return existsSync(changelog) && /^#{1,3}\s+Unreleased\b/im.test(readFileSync(changelog, "utf8"))
})

for (const name of stale) console.error(`packages/${name}/CHANGELOG.md still has an "Unreleased" heading: put its entries under the version they ship in.`)
if (stale.length > 0) process.exit(1)
console.log(`${published.length} published packages, none with an Unreleased changelog heading.`)
