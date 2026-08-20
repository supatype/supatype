/**
 * Standalone CLI archive download, used by `supatype self-update`.
 *
 * The artefact is a per-platform archive holding one executable, not a bare executable, and it
 * is verified against the release's checksums.sha256 before anything is replaced. Previously
 * this path checked only that the download was over 64 bytes and did not begin like HTML or
 * JSON, which made the CLI stricter about a postgres archive than about overwriting itself.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { currentPlatform, fetchChecksums, type PlatformId } from "./binary-cache.js"
import {
  cliArchiveName,
  cliArchivePath,
  cliChecksumsPath,
  cliExecutableName,
  currentLibc,
  type LibcId,
} from "./cli-artifacts.js"

/**
 * Overridable for the same reason scripts/install.sh takes SUPATYPE_CDN: with the host fixed,
 * nothing can exercise this path except a real release, which is how it came to request bare
 * executables the publisher had stopped writing. SUPATYPE_CDN_BASE is the CDN root, where
 * install.sh's SUPATYPE_CDN is the root plus /cli.
 *
 * binary-cache.ts hardcodes the same host for component downloads and could use the same
 * treatment, which is left alone here as it is not part of this change.
 */
const CDN_BASE = process.env["SUPATYPE_CDN_BASE"]?.replace(/\/$/, "")
  || "https://releases.supatype.com"

/** Where a downloaded release is unpacked, so a repeated update does not refetch it. */
export function cliCachePath(
  version: string,
  platform: PlatformId = currentPlatform(),
): string {
  return join(homedir(), ".supatype", "cache", "cli", version, cliExecutableName(platform))
}

export async function fetchStandaloneCliLatestVersion(): Promise<string> {
  const resp = await fetch(`${CDN_BASE}/cli/latest.json`)
  if (!resp.ok) {
    throw new Error(`Failed to fetch CLI latest.json: HTTP ${resp.status}`)
  }
  const data = await resp.json() as { version?: unknown }
  if (typeof data.version !== "string" || data.version.trim() === "") {
    throw new Error("Invalid cli/latest.json: missing version")
  }
  return data.version.trim()
}

async function fetchBytes(url: string, what: string): Promise<Buffer> {
  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`Failed to download ${what} from ${url}: HTTP ${resp.status}`)
  }
  return Buffer.from(await resp.arrayBuffer())
}

/**
 * Unpack the single executable from an archive.
 *
 * PowerShell on Windows, because Git Bash's tar is usually first on PATH there and chokes on
 * drive-letter paths. The same split exists in commands/dev.ts for component archives.
 */
function unpackExecutable(archivePath: string, destDir: string, platform: PlatformId): string {
  mkdirSync(destDir, { recursive: true })
  const result = platform.os === "windows"
    ? spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
        ],
        { stdio: "pipe" },
      )
    : spawnSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "pipe" })

  if (result.status !== 0) {
    throw new Error(
      `Failed to unpack ${archivePath}: ${result.stderr?.toString().trim() || "unknown error"}`,
    )
  }

  const exe = join(destDir, cliExecutableName(platform))
  if (!existsSync(exe)) {
    throw new Error(
      `${cliArchiveName(platform)} did not contain ${cliExecutableName(platform)}.`,
    )
  }
  return exe
}

/**
 * Download and verify the standalone CLI for this machine, returning the path to the
 * executable. Nothing is written to the cache until the checksum matches.
 */
export async function downloadStandaloneCli(
  version?: string,
  platform: PlatformId = currentPlatform(),
  libc: LibcId = currentLibc(platform),
): Promise<string> {
  const resolved = version ?? await fetchStandaloneCliLatestVersion()
  const dest = cliCachePath(resolved, platform)
  if (existsSync(dest)) return dest

  const name = cliArchiveName(platform, libc)
  const archive = await fetchBytes(`${CDN_BASE}${cliArchivePath(resolved, platform, libc)}`, name)

  // The manifest is verified before it is trusted, and only then is the archive compared
  // against it. A checksum alone would prove the download was intact, not that it came from
  // us, and the signature is what makes replacing our own executable no weaker than fetching
  // a postgres archive. fetchChecksums treats the .minisig as mandatory and fails closed
  // without a public key, which is the same rule component downloads follow.
  const checksumsUrl = `${CDN_BASE}${cliChecksumsPath(resolved)}`
  const expected = await fetchChecksums(checksumsUrl, `${checksumsUrl}.minisig`, name)
  const actual = createHash("sha256").update(archive).digest("hex")
  if (actual !== expected.checksum) {
    throw new Error(
      `Checksum mismatch for ${name}.\n  expected: ${expected.checksum}\n  actual:   ${actual}`,
    )
  }

  const staging = join(tmpdir(), `supatype-cli-${resolved}-${process.pid}`)
  try {
    mkdirSync(staging, { recursive: true })
    const archivePath = join(staging, name)
    writeFileSync(archivePath, archive)
    const unpacked = unpackExecutable(archivePath, staging, platform)

    mkdirSync(join(dest, ".."), { recursive: true })
    writeFileSync(dest, readFileSync(unpacked))
    if (platform.os !== "windows") chmodSync(dest, 0o755)
    return dest
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
