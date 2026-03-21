#!/usr/bin/env node
/**
 * Set a unified version across all publishable packages.
 *
 * Usage: node scripts/set-version.mjs 0.1.0-alpha.1
 *
 * Only updates the "version" field. Internal workspace:* dependencies are left
 * as-is — pnpm automatically rewrites them to the concrete version at publish
 * time, so the lockfile stays valid throughout the release CI run.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const version = process.argv[2]
if (!version) {
  console.error("Usage: node scripts/set-version.mjs <version>")
  process.exit(1)
}

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")
const packagesDir = join(root, "packages")

const publishable = [
  "schema",
  "client",
  "react",
  "react-auth",
  "cli",
  // Services (not published to npm but version is useful in image labels)
  "storage",
  "realtime",
  "studio",
]

let updated = 0
for (const dir of publishable) {
  const pkgPath = join(packagesDir, dir, "package.json")
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    pkg.version = version
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8")
    console.log(`  ${pkg.name} → ${version}`)
    updated++
  } catch {
    // skip if package doesn't exist
  }
}

console.log(`\nSet ${updated} packages to v${version}`)
