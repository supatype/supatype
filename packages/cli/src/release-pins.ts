/**
 * Release pins read from files under packages/cli/releases/.
 * CI (deno-releases workflow) uses the same paths — bump only releases/deno/VERSION.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const CLI_PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function readPinFile(...segments: string[]): string {
  const path = join(CLI_PACKAGE_ROOT, "releases", ...segments)
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    throw new Error(
      `Missing release pin file: ${path}\n` +
        "Expected packages/cli/releases/… — reinstall @supatype/cli or build from the monorepo.",
    )
  }
  const version = raw.trim()
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Invalid pin in ${path}: expected semver like 2.2.0, got ${JSON.stringify(raw)}`)
  }
  return version
}

/** Pinned Deno runtime for edge functions (also published to CDN under /deno/v{version}/). */
export const DENO_RELEASE_PIN = readPinFile("deno", "VERSION")
