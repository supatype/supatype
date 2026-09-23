#!/usr/bin/env node
/**
 * Download CDN component binaries for integration tests.
 * Fetches the latest available version for each component from the CDN's
 * `latest.json` manifest, then patches tests/integration/supatype.config.ts
 * so the integration tests resolve the same cached binaries.
 * Components without a published latest.json are skipped (pre-first-release).
 *
 * Run after `pnpm build` (needs packages/cli/dist).
 */
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readFileSync, writeFileSync } from "node:fs"
import {
  BINARY_COMPONENTS,
  fetchAllLatestVersions,
  downloadAll,
  verifyCachedBinaries,
} from "../../../packages/cli/dist/binary-cache.js"

const integrationDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const configPath = resolve(integrationDir, "supatype.config.ts")

console.log("[ci] Fetching latest component versions from CDN...")
const versions = await fetchAllLatestVersions()
console.log(
  "[ci] Resolved versions:",
  Object.entries(versions).map(([k, v]) => `${k}@${v}`).join(", "),
)
const unresolved = BINARY_COMPONENTS.filter((c) => !versions[c])
if (unresolved.length > 0) {
  console.log(
    `[ci] Skipping unpublished CDN components (no latest.json): ${unresolved.join(", ")}`,
  )
}

// Patch the integration test config so tests resolve the same cached binaries.
let config = readFileSync(configPath, "utf8")
for (const [component, version] of Object.entries(versions)) {
  config = config.replace(
    new RegExp(`(${component}\\s*:\\s*['"])[^'"]*(['"])`),
    `$1${version}$2`,
  )
}
writeFileSync(configPath, config, "utf8")

console.log("[ci] Prefetching component binaries...")
await downloadAll(versions, false)
verifyCachedBinaries(versions)
console.log("[ci] Resolved CDN binaries verified (checksum + ELF/archive magic).")
console.log("[ci] Done.")
