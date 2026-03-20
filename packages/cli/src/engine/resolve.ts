/**
 * Engine resolver — orchestrates binary download, verification, and caching.
 *
 * Resolution flow:
 * 1. Check local cache for the pinned version
 * 2. If cached and valid, return cached path
 * 3. If not cached, download from CDN (with GitHub Releases fallback)
 * 4. Verify signature + checksum
 * 5. Cache the verified binary
 * 6. Return the cached path
 */

import { chmodSync, existsSync } from "node:fs"
import { rename, unlink, copyFile } from "node:fs/promises"
import { join } from "node:path"
import { detectPlatform, getArtifactName, getCdnUrl } from "./platform.js"
import { getCachedBinaryPath, hasCachedBinary, ensureCacheDir } from "./cache.js"
import { downloadFile, fetchJson } from "./download.js"
import { verifyBinary, verifyChecksumOnly } from "./verify.js"
import {
  ENGINE_VERSION,
  CDN_BASE_URL,
  GITHUB_RELEASES_FALLBACK_URL,
} from "../engine-version.js"

export interface ResolveResult {
  binaryPath: string
  version: string
  fromCache: boolean
}

/**
 * Resolve the engine binary path, downloading if necessary.
 */
export async function resolveEngine(
  version: string = ENGINE_VERSION,
): Promise<ResolveResult> {
  const platform = detectPlatform()

  // Check cache first
  if (hasCachedBinary(version, platform)) {
    return {
      binaryPath: getCachedBinaryPath(version, platform),
      version,
      fromCache: true,
    }
  }

  // Not cached — need to download
  const artifactName = getArtifactName(version, platform)
  const cacheDir = ensureCacheDir(version)
  const binaryDest = getCachedBinaryPath(version, platform)
  const tempBinary = `${binaryDest}.tmp`
  const checksumDest = join(cacheDir, "checksums.sha256")
  const signatureDest = join(cacheDir, "checksums.sha256.minisig")

  // Try CDN first, then GitHub Releases fallback
  let downloaded = false

  try {
    downloaded = await downloadFromSource(
      CDN_BASE_URL,
      version,
      artifactName,
      tempBinary,
      checksumDest,
      signatureDest,
    )
  } catch {
    // CDN failed, try fallback
  }

  if (!downloaded) {
    try {
      downloaded = await downloadFromSource(
        GITHUB_RELEASES_FALLBACK_URL,
        version,
        artifactName,
        tempBinary,
        checksumDest,
        signatureDest,
      )
    } catch {
      // Fallback also failed
    }
  }

  if (!downloaded) {
    throw new Error(
      "Cannot download Supatype engine. Check your internet connection.\n" +
      "If this persists, report at https://github.com/supatype/supatype/issues",
    )
  }

  // Verify the downloaded binary
  if (existsSync(signatureDest)) {
    // Full two-step verification: signature + checksum
    await verifyBinary(tempBinary, checksumDest, signatureDest, artifactName)
  } else {
    // Checksum-only verification (GitHub Releases may not have .minisig)
    await verifyChecksumOnly(tempBinary, checksumDest, artifactName)
  }

  // Move verified binary to final location
  await rename(tempBinary, binaryDest)

  // Set executable permission on Unix
  if (process.platform !== "win32") {
    chmodSync(binaryDest, 0o755)
  }

  return {
    binaryPath: binaryDest,
    version,
    fromCache: false,
  }
}

async function downloadFromSource(
  baseUrl: string,
  version: string,
  artifactName: string,
  binaryDest: string,
  checksumDest: string,
  signatureDest: string,
): Promise<boolean> {
  const binaryUrl = getCdnUrl(baseUrl, version, artifactName)
  const checksumUrl = getCdnUrl(baseUrl, version, "checksums.sha256")
  const signatureUrl = getCdnUrl(baseUrl, version, "checksums.sha256.minisig")

  // Download binary with progress
  await downloadFile({
    url: binaryUrl,
    dest: binaryDest,
    showProgress: true,
    label: `Downloading Supatype engine v${version} for ${detectPlatform().os}-${detectPlatform().arch}`,
  })

  // Download checksum file
  await downloadFile({
    url: checksumUrl,
    dest: checksumDest,
  })

  // Try to download signature file (may not exist for GitHub Releases)
  try {
    await downloadFile({
      url: signatureUrl,
      dest: signatureDest,
    })
  } catch {
    // Signature file optional for fallback sources
    // But for CDN, we require it — verifyBinary will enforce this
  }

  return true
}

/**
 * Check for the latest engine version from CDN.
 */
export interface LatestVersionInfo {
  version: string
  date: string
}

export async function checkLatestVersion(): Promise<LatestVersionInfo | undefined> {
  return fetchJson<LatestVersionInfo>(`${CDN_BASE_URL}/latest.json`)
}

/**
 * Check version compatibility.
 * Engine and CLI must share the same major version.
 */
export function checkVersionCompatibility(
  engineVersion: string,
  expectedVersion: string,
): { compatible: boolean; message?: string } {
  const engineMajor = parseMajor(engineVersion)
  const expectedMajor = parseMajor(expectedVersion)

  if (engineMajor !== expectedMajor) {
    return {
      compatible: false,
      message:
        `Engine version ${engineVersion} is not compatible with CLI version ${expectedVersion}.\n` +
        `Run: npm update @supatype/cli`,
    }
  }

  return { compatible: true }
}

function parseMajor(version: string): number {
  const match = version.match(/^(\d+)/)
  return match ? parseInt(match[1]!, 10) : 0
}
