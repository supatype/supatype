/**
 * Standalone CLI archive download, used by `supatype self-update`.
 *
 * The artefact is a per-platform archive holding one executable, not a bare executable, and it
 * is verified against the release's checksums.sha256 before anything is replaced. Previously
 * this path checked only that the download was over 64 bytes and did not begin like HTML or
 * JSON, which made the CLI stricter about a postgres archive than about overwriting itself.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fetchChecksums, readLatestVersion, type PlatformId } from "./binary-cache.js"
import {
  cliArchiveName,
  cliArchivePath,
  cliChecksumsPath,
  cliExecutableName,
  currentLibc,
  type LibcId,
} from "./cli-artifacts.js"
import { cliCachePath, publishedTarget } from "./cli-program-path.js"
import { uniqueFileToken } from "./unique-file-token.js"

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

export async function fetchStandaloneCliLatestVersion(): Promise<string> {
  const resp = await fetch(`${CDN_BASE}/cli/latest.json`)
  if (!resp.ok) {
    throw new Error(`Failed to fetch CLI latest.json: HTTP ${resp.status}`)
  }
  return readLatestVersion(resp, "cli/latest.json")
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
 * Moves a verified executable into the cache in one step.
 *
 * The npm starter treats a file at the cache path as verified and runs it, so a half-written one
 * would be run on every later start: written in place, an interrupted download left exactly that.
 * Two first runs at once both download. On Windows the second rename fails while the first copy
 * is running, and either copy is the same verified file, so that loss is not an error.
 */
function publishAtomically(unpacked: string, dest: string, platform: PlatformId): void {
  mkdirSync(join(dest, ".."), { recursive: true })
  const partial = `${dest}.${uniqueFileToken()}.partial`
  copyFileSync(unpacked, partial)
  if (platform.os !== "windows") chmodSync(partial, 0o755)
  try {
    renameSync(partial, dest)
  } catch (err) {
    rmSync(partial, { force: true })
    if (!existsSync(dest)) throw err
  }
}

/** A version's archive for this machine, once it matches the signed checksums manifest. */
async function fetchVerifiedArchive(version: string, platform: PlatformId, libc: LibcId): Promise<Buffer> {
  const name = cliArchiveName(platform, libc)
  const checksumsUrl = `${CDN_BASE}${cliChecksumsPath(version)}`

  // The manifest is verified before it is trusted, and only then is the archive compared
  // against it. A checksum alone would prove the download was intact, not that it came from
  // us, and the signature is what makes replacing our own executable no weaker than fetching
  // a postgres archive. fetchChecksums treats the .minisig as mandatory and fails closed
  // without a public key, which is the same rule component downloads follow. The two are
  // fetched together, so a manifest that fails its signature is reported without waiting for
  // the archive.
  const [expected, archive] = await Promise.all([
    fetchChecksums(checksumsUrl, `${checksumsUrl}.minisig`, name),
    fetchBytes(`${CDN_BASE}${cliArchivePath(version, platform, libc)}`, name),
  ])
  const actual = createHash("sha256").update(archive).digest("hex")
  if (actual !== expected.checksum) {
    throw new Error(
      `Checksum mismatch for ${name}.\n  expected: ${expected.checksum}\n  actual:   ${actual}`,
    )
  }
  return archive
}

/**
 * Download and verify the standalone CLI for this machine, returning the path to the
 * executable. Nothing is written to the cache until the checksum matches. A machine no release
 * is built for is refused here, before any request.
 */
export async function downloadStandaloneCli(
  version?: string,
  platform: PlatformId = publishedTarget(),
  libc: LibcId = currentLibc(platform),
): Promise<string> {
  const resolved = version ?? await fetchStandaloneCliLatestVersion()
  const dest = cliCachePath(resolved, platform)
  if (existsSync(dest)) return dest

  const archive = await fetchVerifiedArchive(resolved, platform, libc)
  const staging = join(tmpdir(), `supatype-cli-${resolved}-${process.pid}`)
  try {
    mkdirSync(staging, { recursive: true })
    const archivePath = join(staging, cliArchiveName(platform, libc))
    writeFileSync(archivePath, archive)
    publishAtomically(unpackExecutable(archivePath, staging, platform), dest, platform)
    return dest
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
