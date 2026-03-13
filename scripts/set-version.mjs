#!/usr/bin/env node
/**
 * Set a unified version across all publishable packages.
 *
 * Usage: node scripts/set-version.mjs 0.1.0-alpha.1
 *
 * Updates package.json version for all @supatype/* packages and
 * rewrites workspace:* dependencies to the concrete version so
 * npm publish resolves them correctly.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const version = process.argv[2]
if (!version) {
  console.error("Usage: node scripts/set-version.mjs <version>")
  process.exit(1)
}

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")
const packagesDir = join(root, "packages")
const examplesDir = join(root, "examples")

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

// Collect all @supatype package names
const supatypePackages = new Set()
for (const dir of publishable) {
  const pkgPath = join(packagesDir, dir, "package.json")
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    supatypePackages.add(pkg.name)
  } catch {
    // skip if doesn't exist
  }
}

// Update each package
let updated = 0
for (const dir of publishable) {
  const pkgPath = join(packagesDir, dir, "package.json")
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    pkg.version = version

    // Rewrite workspace:* deps to concrete version
    for (const depType of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = pkg[depType]
      if (!deps) continue
      for (const [name, value] of Object.entries(deps)) {
        if (supatypePackages.has(name) && String(value).startsWith("workspace:")) {
          deps[name] = version
        }
      }
    }

    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8")
    console.log(`  ${pkg.name} → ${version}`)
    updated++
  } catch {
    // skip
  }
}

// Also update examples if they exist
try {
  for (const dir of readdirSync(examplesDir)) {
    const pkgPath = join(examplesDir, dir, "package.json")
    try {
      if (!statSync(pkgPath).isFile()) continue
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
      for (const depType of ["dependencies", "devDependencies"]) {
        const deps = pkg[depType]
        if (!deps) continue
        for (const [name, value] of Object.entries(deps)) {
          if (supatypePackages.has(name) && String(value).startsWith("workspace:")) {
            deps[name] = version
          }
        }
      }
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8")
    } catch {
      // skip
    }
  }
} catch {
  // no examples dir
}

console.log(`\nSet ${updated} packages to v${version}`)
