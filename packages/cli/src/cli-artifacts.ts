/**
 * Names and locations of the published standalone CLI artefacts.
 *
 * One place, because this layout had drifted into five: the release workflow, install.sh,
 * this module's caller, the Homebrew generator and a now-deleted second installer all
 * described it independently, and `supatype self-update` was asking for bare executables the
 * publisher had stopped writing. `scripts/install.sh` cannot import this (it runs before any
 * CLI exists on the machine), so the shell keeps its own copy; what holds the two together is
 * the round-trip test in tests/integration/scripts/cli-artifact-roundtrip.sh, not this file.
 */

import { existsSync, readdirSync } from "node:fs"
import { currentPlatform, type PlatformId } from "./binary-cache.js"

/**
 * Which C library the running system provides. Only meaningful on Linux: Bun links
 * libstdc++ and libgcc dynamically, so a glibc build cannot start on Alpine, and installing a
 * glibc binary over a working musl one is how a self-update would brick an Alpine install.
 */
export type LibcId = "glibc" | "musl"

/** Detects musl by its dynamic loader, the same signal scripts/install.sh uses. */
export function currentLibc(platform: PlatformId = currentPlatform()): LibcId {
  if (platform.os !== "linux") return "glibc"
  if (!existsSync("/lib")) return "glibc"
  try {
    const musl = readdirSync("/lib").some((f) => f.startsWith("ld-musl-") && f.endsWith(".so.1"))
    return musl ? "musl" : "glibc"
  } catch {
    return "glibc"
  }
}

/**
 * The archive published for a platform. Windows gets a zip because that is what Windows
 * users can open without extra tools; everything else is a tarball. Both hold a single
 * executable called `supatype` (`supatype.exe` on Windows), whatever the archive is named.
 */
export function cliArchiveName(
  platform: PlatformId = currentPlatform(),
  libc: LibcId = currentLibc(platform),
): string {
  const suffix = platform.os === "linux" && libc === "musl" ? "-musl" : ""
  const ext = platform.os === "windows" ? "zip" : "tar.gz"
  return `supatype-cli-${platform.os}-${platform.arch}${suffix}.${ext}`
}

/** The executable inside the archive. */
export function cliExecutableName(platform: PlatformId = currentPlatform()): string {
  return platform.os === "windows" ? "supatype.exe" : "supatype"
}

/** CDN path of a version's archive, relative to the CDN root. */
export function cliArchivePath(
  version: string,
  platform: PlatformId = currentPlatform(),
  libc: LibcId = currentLibc(platform),
): string {
  return `/cli/v${version}/${cliArchiveName(platform, libc)}`
}

/** CDN path of the checksums file covering every archive in a version. */
export function cliChecksumsPath(version: string): string {
  return `/cli/v${version}/checksums.sha256`
}
