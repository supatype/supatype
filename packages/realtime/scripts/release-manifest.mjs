#!/usr/bin/env node
/**
 * Write the signed-release manifests for one realtime version.
 *
 * Usage: node packages/realtime/scripts/release-manifest.mjs <binaries-dir> <version> <latest-json-out>
 *
 * Writes `<binaries-dir>/checksums.sha256` in sha256sum's format (`<hex>  <name>`), covering every
 * platform binary the CLI downloads, and `<latest-json-out>` in the shape every other component's
 * latest.json has. The CLI refuses a component whose release has no minisign-signed checksums
 * manifest, and published paths are immutable, so a version that goes out without one can never be
 * fixed, only superseded. Refusing here, before anything is uploaded, is the only place it can be.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The CLI's binaryName("realtime", ...) for each platform it supports, and nothing else. */
const RELEASE_BINARIES = [
  "supatype-realtime-darwin-amd64",
  "supatype-realtime-darwin-arm64",
  "supatype-realtime-linux-amd64",
  "supatype-realtime-linux-arm64",
  "supatype-realtime-windows-amd64.exe",
]

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function checksumsManifest(dir) {
  const missing = RELEASE_BINARIES.filter((name) => !existsSync(join(dir, name)))
  if (missing.length > 0) {
    throw new Error(`refusing to write checksums: missing ${missing.join(", ")} in ${dir}`)
  }
  return RELEASE_BINARIES.map((name) => `${sha256(join(dir, name))}  ${name}\n`).join("")
}

function latestManifest(version) {
  const date = new Date().toISOString().slice(0, 10)
  const checksumsUrl = `https://releases.supatype.com/realtime/v${version}/checksums.sha256`
  return `${JSON.stringify({ version, date, checksums_url: checksumsUrl })}\n`
}

function main(argv) {
  const [dir, version, latestOut] = argv
  if (dir === undefined || version === undefined || latestOut === undefined) {
    throw new Error("usage: release-manifest.mjs <binaries-dir> <version> <latest-json-out>")
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
