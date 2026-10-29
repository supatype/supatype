#!/usr/bin/env node
/**
 * Write the signed-release manifests for one storage version.
 *
 * Usage: node packages/storage/scripts/release-manifest.mjs <archives-dir> <version> <latest-json-out>
 *
 * Writes `<archives-dir>/checksums.sha256` in sha256sum's format (`<hex>  <name>`), covering every
 * platform archive the CLI downloads, and `<latest-json-out>` in the shape every other component's
 * latest.json has. The same contract as realtime's: the CLI refuses a release without a
 * minisign-signed checksums manifest, and published paths are immutable, so a missing platform is
 * refused here, before anything is uploaded.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The CLI's archive name for storage on each platform it supports, and nothing else. */
const RELEASE_ARCHIVES = [
  "supatype-storage-darwin-amd64.tar.gz",
  "supatype-storage-darwin-arm64.tar.gz",
  "supatype-storage-linux-amd64.tar.gz",
  "supatype-storage-linux-arm64.tar.gz",
  "supatype-storage-windows-amd64.zip",
]

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function checksumsManifest(dir) {
  const missing = RELEASE_ARCHIVES.filter((name) => !existsSync(join(dir, name)))
  if (missing.length > 0) {
    throw new Error(`refusing to write checksums: missing ${missing.join(", ")} in ${dir}`)
  }
  return RELEASE_ARCHIVES.map((name) => `${sha256(join(dir, name))}  ${name}\n`).join("")
}

function latestManifest(version) {
  const date = new Date().toISOString().slice(0, 10)
  const checksumsUrl = `https://releases.supatype.com/storage/v${version}/checksums.sha256`
  return `${JSON.stringify({ version, date, checksums_url: checksumsUrl })}\n`
}

function main(argv) {
  const [dir, version, latestOut] = argv
  if (dir === undefined || version === undefined || latestOut === undefined) {
    throw new Error("usage: release-manifest.mjs <archives-dir> <version> <latest-json-out>")
  }
  if (!SEMVER.test(version)) throw new Error(`refusing to publish version '${version}': not a semantic version`)
  writeFileSync(join(dir, "checksums.sha256"), checksumsManifest(dir))
  writeFileSync(latestOut, latestManifest(version))
  process.stdout.write(readFileSync(join(dir, "checksums.sha256"), "utf8"))
}

try {
  main(process.argv.slice(2))
} catch (err) {
  console.error(`release-manifest: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
