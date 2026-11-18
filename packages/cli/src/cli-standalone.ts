/**
 * Standalone CLI archive download, used by `supatype self-update`.
 *
 * The artefact is a per-platform archive holding one executable, not a bare executable, and it
 * is verified against the release's checksums.sha256 before anything is replaced. Previously
 * this path checked only that the download was over 64 bytes and did not begin like HTML or
 * JSON, which made the CLI stricter about a postgres archive than about overwriting itself.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { cdnGet, downloadToFile, isHostUnavailable } from "./cdn-fetch.js"
import { fetchChecksums, readLatestVersion, withRetry, type PlatformId } from "./binary-cache.js"
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
const CDN_OVERRIDE = process.env["SUPATYPE_CDN_BASE"]?.replace(/\/$/, "")
const CDN_BASE = CDN_OVERRIDE || "https://releases.supatype.com"

/**
 * Where the release workflow attaches the same archives and checksums files, flat under the tag
 * (release.yml's github-release job). Only releases published with that step have them there.
 */
export const GITHUB_RELEASES_BASE = "https://github.com/supatype/supatype/releases/download"

export async function fetchStandaloneCliLatestVersion(): Promise<string> {
  const url = `${CDN_BASE}/cli/latest.json`
  const resp = await withRetry(() => cdnGet(url))
  if (!resp.ok) {
    throw new Error(`Failed to fetch CLI latest.json from ${url}: HTTP ${resp.status}. Try again in a moment.`)
  }
  return readLatestVersion(resp, "cli/latest.json")
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

/** One place a release can be fetched from: its signed manifest (and signature beside it) and its archive. */
interface ReleaseSource {
  label: string
  checksumsUrl: string
  archiveUrl: string
}

/** The CDN, then GitHub Releases. A mirror the user chose with SUPATYPE_CDN_BASE has no fallback. */
function releaseSources(version: string, platform: PlatformId, libc: LibcId): ReleaseSource[] {
  const cdn: ReleaseSource = {
    label: CDN_BASE,
    checksumsUrl: `${CDN_BASE}${cliChecksumsPath(version)}`,
    archiveUrl: `${CDN_BASE}${cliArchivePath(version, platform, libc)}`,
  }
  // An explicit mirror is a choice about where bytes come from, often an air-gapped one. Quietly
  // going to github.com instead would override it, so a mirror that fails is reported as failed.
  if (CDN_OVERRIDE) return [cdn]
  const tag = `${GITHUB_RELEASES_BASE}/v${version}`
  return [
    cdn,
    {
      label: "GitHub Releases",
      checksumsUrl: `${tag}/checksums.sha256`,
      archiveUrl: `${tag}/${cliArchiveName(platform, libc)}`,
    },
  ]
}

/**
 * One source's archive, written to `archivePath` once it matches that source's signed checksums
 * manifest. The manifest is verified before it is trusted, and only then is the archive compared
 * against it. A checksum alone would prove the download was intact, not that it came from us, and
 * the signature is what makes replacing our own executable no weaker than fetching a postgres
 * archive. fetchChecksums treats the .minisig as mandatory and fails closed without a public key,
 * which is the same rule component downloads follow, and it is the same call for every source.
 *
 * The manifest and the archive are fetched together, so a manifest that fails its signature is
 * reported without waiting for the archive. Both settle before this returns or throws, so a failed
 * attempt never leaves a request writing to `archivePath` while the next source starts.
 */
async function fetchVerifiedFrom(source: ReleaseSource, name: string, archivePath: string, version: string): Promise<void> {
  const [manifest, download] = await Promise.allSettled([
    fetchChecksums(source.checksumsUrl, `${source.checksumsUrl}.minisig`, name),
    withRetry(() => downloadToFile(source.archiveUrl, archivePath, `supatype ${version}`)),
  ])
  if (manifest.status === "rejected") throw manifest.reason
  if (download.status === "rejected") throw download.reason
  const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex")
  if (actual !== manifest.value.checksum) {
    throw new Error(
      `Checksum mismatch for ${name}.\n  expected: ${manifest.value.checksum}\n  actual:   ${actual}`,
    )
  }
}

/**
 * A version's archive for this machine, written to `archivePath` once it matches the signed
 * checksums manifest of the source that served it. The download resumes across its retries, and the
 * checksum is of the whole file.
 *
 * The next source is tried only when this one could not answer: a 5xx or no connection, after the
 * retries. A 404 (the release is not there) and a checksum or signature failure (what was served is
 * wrong) end the download, because another host would not change either, and trying one would turn
 * a refusal into a second chance for a bad file.
 */
export async function fetchVerifiedArchive(
  version: string,
  platform: PlatformId,
  libc: LibcId,
  archivePath: string,
): Promise<void> {
  const name = cliArchiveName(platform, libc)
  const sources = releaseSources(version, platform, libc)
  for (const [i, source] of sources.entries()) {
    try {
      await fetchVerifiedFrom(source, name, archivePath, version)
      return
    } catch (err) {
      const next = sources[i + 1]
      if (next === undefined || !isHostUnavailable(err)) throw err
      process.stderr.write(
        `[supatype] ${source.label} is not answering; downloading from ${next.label} instead. ` +
          "It is still verified against the signed checksums.\n",
      )
      // Emptied first: the next source's download resumes from whatever is at the archive path.
      rmSync(archivePath, { force: true })
    }
  }
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

  const staging = join(tmpdir(), `supatype-cli-${resolved}-${process.pid}`)
  try {
    // Emptied first: the download resumes from whatever is at the archive path.
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    const archivePath = join(staging, cliArchiveName(platform, libc))
    await fetchVerifiedArchive(resolved, platform, libc, archivePath)
    publishAtomically(unpackExecutable(archivePath, staging, platform), dest, platform)
    return dest
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
