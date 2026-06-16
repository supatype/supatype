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

/** Published to npm on monorepo version tags (dependency order in release.yml). */
const npmPackages = [
  "types",
  "plugin-sdk",
  "client",
  "common",
  "react",
  "react-auth",
  "ssr",
  "ui",
  "plugin-seo",
  "plugin-color-picker",
  "plugin-phone-field",
  "solid",
  "svelte",
  "vue",
  "cli",
]

/** Version-synced for Docker image labels; not published to npm. */
const dockerVersioned = ["storage", "realtime", "studio"]

function setVersion(dir) {
  const pkgPath = join(packagesDir, dir, "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  pkg.version = version
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8")
  console.log(`  ${pkg.name} → ${version}`)
}

let updated = 0
console.log("npm packages:")
for (const dir of npmPackages) {
  try {
    setVersion(dir)
    updated++
  } catch {
    // skip if package doesn't exist
  }
}

console.log("\nDocker-versioned services:")
for (const dir of dockerVersioned) {
  try {
    setVersion(dir)
    updated++
  } catch {
    // skip if package doesn't exist
  }
}

// Examples are private packages — keep workspace:* so the lockfile stays valid.

console.log(`\nSet ${updated} packages to v${version}`)
