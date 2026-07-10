/**
 * Binary cache — manages supatype component binaries.
 *
 * Components: engine, server, postgres, deno, realtime.
 * Cache root: ~/.supatype/cache/{component}/{version}/
 * Override path: config.overrides?.{component} (local build path).
 *
 * Security model:
 *   1. Download checksums.sha256 + checksums.sha256.minisig from CDN.
 *   2. Verify the Ed25519 minisign signature on the checksum file using the
 *      release public key (embedded at publish, overridable via
 *      SUPATYPE_RELEASE_PUBLIC_KEY).
 *   3. Verify SHA256 of the downloaded binary against the signed checksum.
 *   Verification is mandatory and fails closed: if no public key is configured,
 *   the download errors out rather than silently degrading to SHA256-only.
 *   The only escape hatch is the explicit SUPATYPE_ALLOW_UNVERIFIED_DOWNLOADS=1.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto"
import {
  closeSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { chmod } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve, isAbsolute } from "node:path"
import type { SupatypeProjectConfig } from "./project-config.js"
import { loadProjectLink, migrateLegacyLinkFiles } from "./link.js"
import { releasePublicKey } from "./release-public-key.js"
import {
  isDownloadInProgress,
  releaseDownloadLock,
  tryAcquireDownloadLock,
  waitForComponentDownload,
} from "./binary-download-lock.js"

/**
 * Set `versions.{engine|server|postgres|deno}: VERSION_PIN_LOCAL` to mean “use `overrides.*` only”
 * without duplicating the path string (Phase 10.7). Requires the matching `overrides` entry.
 */
export const VERSION_PIN_LOCAL = "local"

/** True if `overrides.engine` points at a local engine binary (contributor dev). */
export function hasEngineOverride(config: SupatypeProjectConfig): boolean {
  const path = config.overrides?.engine
  return typeof path === "string" && path.trim() !== ""
}

export function hasStudioOverride(config: SupatypeProjectConfig): boolean {
  const path = config.overrides?.studio
  return typeof path === "string" && path.trim() !== ""
}

/** True if `overrides` contains any non-empty string path (contributor local builds). */
export function hasMeaningfulOverrides(config: SupatypeProjectConfig): boolean {
  const o = config.overrides
  if (!o) return false
  for (const v of Object.values(o)) {
    if (typeof v === "string" && v.trim() !== "") return true
  }
  return false
}

/** Lines for a startup banner — non-empty override paths only. */
export function describeActiveOverrides(config: SupatypeProjectConfig): string[] {
  const o = config.overrides
  if (!o) return []
  const lines: string[] = []
  const add = (label: string, v: string | undefined) => {
    if (typeof v === "string" && v.trim() !== "") {
      lines.push(`  ${label.padEnd(12)} → ${v.trim()}`)
    }
  }
  add("engine", o.engine)
  add("server", o.server)
  add("postgres_dir", o.postgres_dir)
  add("deno", o.deno)
  add("realtime", o.realtime)
  add("studio", o.studio)
  add("postgrest", o.postgrest)
  return lines
}

/**
 * True when this working tree is associated with a remote Supatype Cloud project:
 * `project.ref` or `.supatype/link.json` (cloud kind).
 */
export function isLinkedToCloudProject(cwd: string, config: SupatypeProjectConfig): boolean {
  const ref = config.project.ref
  if (typeof ref === "string" && ref.trim() !== "") return true

  migrateLegacyLinkFiles(cwd)
  const link = loadProjectLink(cwd)
  if (link?.kind === "cloud" && link.projectRef.trim() !== "") return true

  const linkedPath = join(cwd, ".supatype", "linked.json")
  if (existsSync(linkedPath)) {
    try {
      const data = JSON.parse(readFileSync(linkedPath, "utf8")) as Record<string, unknown>
      if (typeof data["ref"] === "string" && (data["ref"] as string).trim() !== "") return true
    } catch { /* ignore */ }
  }

  const cloudPath = join(cwd, ".supatype", "cloud.json")
  if (existsSync(cloudPath)) {
    try {
      const data = JSON.parse(readFileSync(cloudPath, "utf8")) as { projectSlug?: string }
      if (typeof data.projectSlug === "string" && data.projectSlug.trim() !== "") return true
    } catch { /* ignore */ }
  }

  return false
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { Component, ComponentVersions } from "./components.js"
export { BINARY_COMPONENTS } from "./components.js"
import { BINARY_COMPONENTS, type Component, type ComponentVersions } from "./components.js"

export interface PlatformId {
  os: "linux" | "darwin" | "windows"
  arch: "amd64" | "arm64"
}

// ---------------------------------------------------------------------------
// CDN base URL + release signing public key
// ---------------------------------------------------------------------------

const CDN_BASE = "https://releases.supatype.com"

/** Postgres CDN archives use PG major in the basename (17.2 → `supatype-pg-17-…`). */
export function postgresArchiveTag(version: string): string {
  return version.split(".")[0]!
}

// CDN path templates per component.
const CDN_PATHS: Record<Component, (version: string, platform: PlatformId) => string> = {
  engine:   (v, p) => `/engine/v${v}/supatype-engine-${p.os}-${p.arch}${p.os === "windows" ? ".exe" : ""}`,
  server:   (v, p) => `/server/v${v}/supatype-server-${p.os}-${p.arch}${p.os === "windows" ? ".exe" : ""}`,
  postgres: (v, p) => `/postgres/v${v}/supatype-pg-${postgresArchiveTag(v)}-${p.os}-${p.arch}${p.os === "windows" ? ".zip" : ".tar.gz"}`,
  deno:     (v, p) => `/deno/v${v}/deno-${p.os}-${p.arch}${p.os === "windows" ? ".exe" : ""}`,
  realtime: (v, p) => `/realtime/v${v}/supatype-realtime-${p.os}-${p.arch}${p.os === "windows" ? ".exe" : ""}`,
}

// Checksums file path (one per version directory, covers all platform binaries).
const checksumsDirPath = (component: Component, version: string): string =>
  `/${component}/v${version}/checksums.sha256`

// ---------------------------------------------------------------------------
// Cache paths
// ---------------------------------------------------------------------------

export function cacheRoot(): string {
  return join(homedir(), ".supatype", "cache")
}

export function cachePath(component: Component, version: string): string {
  return join(cacheRoot(), component, version)
}

export function cachedBinaryPath(component: Component, version: string, platform: PlatformId): string {
  return join(cachePath(component, version), binaryName(component, version, platform))
}

/** True when the platform binary for `version` is present and passes format checks. */
export function isCachedBinaryReady(
  component: Component,
  version: string,
  platform: PlatformId = currentPlatform(),
): boolean {
  const destPath = cachedBinaryPath(component, version, platform)
  return existsSync(destPath) && cachedArtifactLooksValid(component, destPath)
}

function binaryName(component: Component, version: string, platform: PlatformId): string {
  const win = platform.os === "windows"
  switch (component) {
    case "engine":   return `supatype-engine-${platform.os}-${platform.arch}${win ? ".exe" : ""}`
    case "server":   return `supatype-server-${platform.os}-${platform.arch}${win ? ".exe" : ""}`
    case "postgres": return `supatype-pg-${postgresArchiveTag(version)}-${platform.os}-${platform.arch}${win ? ".zip" : ".tar.gz"}`
    case "deno":     return `deno-${platform.os}-${platform.arch}${win ? ".exe" : ""}`
    case "realtime": return `supatype-realtime-${platform.os}-${platform.arch}${win ? ".exe" : ""}`
  }
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export function currentPlatform(): PlatformId {
  let os: PlatformId["os"]
  if (process.platform === "darwin") os = "darwin"
  else if (process.platform === "win32") os = "windows"
  else os = "linux"

  const rawArch = process.arch
  let arch: PlatformId["arch"]
  if (rawArch === "arm64") arch = "arm64"
  else if (rawArch === "x64") arch = "amd64"
  else throw new Error(`Unsupported architecture: ${rawArch}`)
  return { os, arch }
}

// ---------------------------------------------------------------------------
// Override validation
// ---------------------------------------------------------------------------

/**
 * Resolve the binary path for a component.
 *
 * Resolution order:
 * 1. config.overrides?.[component] — local build path (must exist)
 * 2. Cached binary at ~/.supatype/cache/{component}/{version}/
 * 3. Throws — caller should call download() first.
 *
 * Hard error if any meaningful `overrides` entry is set while the project is linked to cloud
 * (`project.ref`, `.supatype/cloud.json`, or `.supatype/linked.json`).
 */
export async function resolveBinary(
  component: Component,
  config: SupatypeProjectConfig,
): Promise<string> {
  const cwd = process.cwd()
  if (hasMeaningfulOverrides(config) && isLinkedToCloudProject(cwd, config)) {
    throw new Error(
      "[overrides] cannot be used while this project is linked to Supatype Cloud " +
        "(project.ref, .supatype/cloud.json, or .supatype/linked.json).\n" +
        "Remove overrides from supatype.config.ts / supatype.local.config.ts, or remove the cloud link files / clear project.ref.",
    )
  }

  const overridePath = config.overrides?.[component === "postgres" ? "postgres_dir" : component]
  const version = await resolveVersionFor(component, config)

  if (version === VERSION_PIN_LOCAL && !overridePath) {
    const key = component === "postgres" ? "postgres_dir" : component
    throw new Error(
      `[versions] versions.${component} is "${VERSION_PIN_LOCAL}" but overrides.${key} is not set. ` +
        `Set overrides.${key} to your local build path, or pin a semver in versions.${component}.`,
    )
  }

  if (overridePath) {
    const normalised = normalisePlatformPath(overridePath)
    let resolvedOverride = isAbsolute(normalised)
      ? normalised
      : resolve(process.cwd(), normalised)

    if (process.platform === "win32" && !/\.\w+$/.test(resolvedOverride) && !existsSync(resolvedOverride)) {
      const withExe = resolvedOverride + ".exe"
      if (existsSync(withExe)) resolvedOverride = withExe
    }

    // On Windows, CreateProcess automatically appends .exe to extensionless paths.
    // If the override binary exists without .exe, copy it to path.exe so it
    // spawns correctly (and takes precedence over any stale .exe at that path).
    if (process.platform === "win32" && !/\.\w+$/.test(resolvedOverride) && existsSync(resolvedOverride)) {
      const withExe = resolvedOverride + ".exe"
      const srcStat = statSync(resolvedOverride)
      const dstStat = existsSync(withExe) ? statSync(withExe) : null
      if (!dstStat || dstStat.size !== srcStat.size || dstStat.mtimeMs < srcStat.mtimeMs) {
        copyFileSync(resolvedOverride, withExe)
      }
      resolvedOverride = withExe
    }

    if (!existsSync(resolvedOverride)) {
      throw new Error(`[overrides] ${component} path does not exist: ${resolvedOverride}`)
    }

    const stat = statSync(resolvedOverride)
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error(`[overrides] ${component} path is not a file or directory: ${resolvedOverride}`)
    }

    return resolvedOverride
  }

  const platform = currentPlatform()
  const binPath = cachedBinaryPath(component, version, platform)

  if (existsSync(binPath)) return binPath

  throw new Error(`${component} v${version} not found in cache. Run: supatype update`)
}

// ---------------------------------------------------------------------------
// Download + verify
// ---------------------------------------------------------------------------

/**
 * Download a component binary to the cache.
 *
 * Verification order:
 *   1. Fetch checksums.sha256 + checksums.sha256.minisig from CDN.
 *   2. If SUPATYPE_RELEASE_PUBLIC_KEY is set: verify minisign signature.
 *   3. Verify SHA256 of downloaded binary against signed checksum.
 */
/** Download if missing or invalid; return cached path for the given platform. */
export async function ensureCachedBinary(
  component: Component,
  version: string,
  platform: PlatformId,
): Promise<string> {
  return download(component, version, platform)
}

async function acquireDownloadSlot(
  component: Component,
  version: string,
  platform: PlatformId,
): Promise<void> {
  const isReady = () => isCachedBinaryReady(component, version, platform)

  for (let attempt = 0; attempt < 3; attempt++) {
    if (isReady()) return

    if (tryAcquireDownloadLock(component, version)) return

    if (isDownloadInProgress(component, version)) {
      console.log(
        `[supatype] ${component} v${version} is downloading in another process — waiting...`,
      )
      const outcome = await waitForComponentDownload(component, version, isReady, (c) => {
        console.log(`[supatype] Still waiting for ${c} download...`)
      })
      if (outcome === "ready") return
      if (outcome === "timeout") {
        throw new Error(
          `Timed out waiting for ${component} v${version} download. Run: supatype update`,
        )
      }
      console.warn(
        `[supatype] ${component} v${version} download did not finish in the other process — retrying.`,
      )
      continue
    }

    if (tryAcquireDownloadLock(component, version)) return
  }

  throw new Error(
    `Could not acquire download lock for ${component} v${version}. Run: supatype update`,
  )
}

export async function download(
  component: Component,
  version: string,
  platform: PlatformId,
): Promise<string> {
  if (version === VERSION_PIN_LOCAL) {
    throw new Error(
      `cannot download CDN binary when version is "${VERSION_PIN_LOCAL}" — set overrides.${component === "postgres" ? "postgres_dir" : component} or pin a semver`,
    )
  }

  const dir = cachePath(component, version)
  mkdirSync(dir, { recursive: true })

  const name = binaryName(component, version, platform)
  const destPath = join(dir, name)

  if (existsSync(destPath)) {
    if (cachedArtifactLooksValid(component, destPath)) {
      console.log(`[supatype] ${component} v${version} already cached.`)
      return destPath
    }
    console.warn(
      `[supatype] ${component} v${version} cache invalid — re-downloading (${destPath}).`,
    )
    unlinkSync(destPath)
  }

  await acquireDownloadSlot(component, version, platform)
  if (isCachedBinaryReady(component, version, platform)) {
    return destPath
  }

  const binaryUrl = `${CDN_BASE}${CDN_PATHS[component](version, platform)}`
  const checksumsUrl = `${CDN_BASE}${checksumsDirPath(component, version)}`
  const minisigUrl = `${checksumsUrl}.minisig`

  console.log(`[supatype] Downloading ${component} v${version} (${platform.os}/${platform.arch})...`)

  const tmpPath = destPath + ".tmp"
  try {
    // ── Fetch checksums + optional minisig (retried on transient failures) ───
    const expectedChecksum = await withRetry(() =>
      fetchChecksums(checksumsUrl, minisigUrl, name),
    )

    // ── Stream-download binary with progress (retried on transient failures) ─
    await withRetry(() => streamToFileWithProgress(binaryUrl, tmpPath))

    // ── Verify SHA256 ────────────────────────────────────────────────────────
    await verifyChecksum(tmpPath, expectedChecksum, component)

    writeFileSync(destPath, readFileSync(tmpPath))

    assertArtifactFormat(component, destPath, platform)
    if (process.platform !== "win32" && EXECUTABLE_COMPONENTS.has(component)) {
      await chmod(destPath, 0o755)
    }
  } catch (err) {
    // Never leave a partial binary or an empty version directory behind: a stale
    // empty dir makes the next resolve look fine while silently lacking a binary.
    try { if (existsSync(destPath)) unlinkSync(destPath) } catch { /* ignore */ }
    try { rmdirSync(dir) } catch { /* dir not empty or already removed */ }
    throw new Error(
      `Failed to download ${component} v${version} from ${CDN_BASE}: ${(err as Error).message}`,
    )
  } finally {
    releaseDownloadLock(component, version)
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
    }
  }

  return destPath
}

/**
 * Fetch checksums.sha256, optionally verify its minisign signature, and
 * return the expected SHA256 for `binaryFilename`.
 */
async function fetchChecksums(
  checksumsUrl: string,
  minisigUrl: string,
  binaryFilename: string,
): Promise<string> {
  const csResp = await fetch(checksumsUrl)
  if (!csResp.ok) {
    throw new Error(`Failed to fetch checksums from ${checksumsUrl}: HTTP ${csResp.status}`)
  }
  const checksumsText = await csResp.text()

  const pubKey = releasePublicKey()
  if (!pubKey) {
    // Fail closed: a missing public key means we cannot verify authenticity, only
    // integrity (SHA256). Published builds always embed the key, so this only
    // happens in source/contributor builds — never silently downgrade.
    if (process.env["SUPATYPE_ALLOW_UNVERIFIED_DOWNLOADS"] === "1") {
      console.warn(
        "[supatype] \u26a0  SUPATYPE_ALLOW_UNVERIFIED_DOWNLOADS=1 — no minisign public " +
          "key configured; verifying SHA256 only (authenticity NOT checked).",
      )
      return extractChecksum(checksumsText, binaryFilename)
    }
    throw new Error(
      "No minisign public key configured — cannot verify release authenticity.\n" +
        "Published @supatype/cli builds embed the key automatically; if you are building " +
        "from source, set SUPATYPE_RELEASE_PUBLIC_KEY to the release public key, or set " +
        "SUPATYPE_ALLOW_UNVERIFIED_DOWNLOADS=1 to download with SHA256-only verification (unsafe).",
    )
  }

  // Minisign signature is mandatory when a public key is configured.
  const sigResp = await fetch(minisigUrl)
  if (!sigResp.ok) {
    throw new Error(
      `Failed to fetch checksum signature from ${minisigUrl}: HTTP ${sigResp.status}\n` +
        "Cannot verify release integrity. Aborting download.",
    )
  }
  const sigText = await sigResp.text()
  verifyMinisign(Buffer.from(checksumsText, "utf8"), sigText, pubKey)

  return extractChecksum(checksumsText, binaryFilename)
}

// ---------------------------------------------------------------------------
// Minisign signature verification (pure Node.js, no external deps)
// ---------------------------------------------------------------------------

/**
 * Ed25519 SPKI DER prefix — wraps a raw 32-byte public key into the
 * SubjectPublicKeyInfo structure that Node.js crypto.createPublicKey expects.
 *
 * Breakdown:
 *   30 2a        SEQUENCE (42 bytes)
 *     30 05      SEQUENCE (5 bytes)
 *       06 03    OID (3 bytes)
 *       2b 65 70 OID value: 1.3.101.112 (id-Ed25519)
 *     03 21      BIT STRING (33 bytes)
 *       00       0 unused bits
 *       <32 bytes Ed25519 public key>
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

/**
 * Verify a minisign signature. Supports both Ed25519 legacy mode ("Ed", over the
 * raw file) and prehashed mode ("ED", over BLAKE2b-512(file)). Throws if invalid.
 */
export function verifyMinisign(fileBytes: Buffer, sigFileContent: string, pubKeyStr: string): void {
  // Parse public key: [2 algo][8 keyId][32 ed25519 key]
  const pkLines = pubKeyStr.trim().split("\n")
  const pkBytes = Buffer.from(pkLines[pkLines.length - 1]!.trim(), "base64")
  if (pkBytes.length < 42) throw new Error("Invalid minisign public key")
  const pkKeyId = pkBytes.subarray(2, 10)
  const pkEd25519 = pkBytes.subarray(10, 42)

  // Parse signature file:
  //   line 0: untrusted comment
  //   line 1: base64 sig bytes — [2 algo][8 keyId][64 Ed25519 sig]
  //   line 2: trusted comment
  //   line 3: base64 global sig (over sig bytes + trusted comment)
  const sigLines = sigFileContent.trim().split("\n")
  if (sigLines.length < 4) throw new Error("Malformed minisign signature file")
  const sigBytes = Buffer.from(sigLines[1]!.trim(), "base64")
  if (sigBytes.length < 74) throw new Error("Invalid minisign signature length")

  const algo = sigBytes.subarray(0, 2)
  const sigKeyId = sigBytes.subarray(2, 10)
  const signature = sigBytes.subarray(10, 74)

  // Both Ed25519 modes are supported:
  //   "Ed" (0x45, 0x64) — legacy: signature is over the raw file bytes.
  //   "ED" (0x45, 0x44) — prehashed: signature is over BLAKE2b-512(file).
  // Modern minisign (and our release pipeline) default to prehashed mode.
  if (algo[0] !== 0x45 || (algo[1] !== 0x64 && algo[1] !== 0x44)) {
    throw new Error(
      "Unsupported minisign algorithm — expected Ed25519 ('Ed' legacy or 'ED' prehashed).\n" +
        `Got: 0x${algo[0]?.toString(16)}${algo[1]?.toString(16)}`,
    )
  }
  const prehashed = algo[1] === 0x44

  if (!sigKeyId.equals(pkKeyId)) {
    throw new Error(
      "Minisign key ID mismatch — signature was produced with a different key.\n" +
        "This could indicate a compromised release. Do not proceed.",
    )
  }

  const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, pkEd25519])
  const keyObject = createPublicKey({ key: spkiDer, format: "der", type: "spki" })

  // Pure Ed25519 (PureEdDSA) verifies over the message directly; for prehashed
  // minisign the "message" is the BLAKE2b-512 digest of the file.
  const signedData = prehashed
    ? createHash("blake2b512").update(fileBytes).digest()
    : fileBytes

  const valid = cryptoVerify(null, signedData, keyObject, signature)
  if (!valid) {
    throw new Error(
      "Minisign signature verification FAILED — the checksum file may have been tampered with.\n" +
        "This could indicate a supply chain attack. Aborting download.",
    )
  }
}

/**
 * Extract the SHA256 hash for `filename` from a checksums.sha256 file.
 * Format: `<hash>  <filename>` (sha256sum output, two spaces).
 */
function extractChecksum(checksumsText: string, filename: string): string {
  const target = basename(filename)
  for (const line of checksumsText.split("\n")) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2 && parts[1] === target) {
      return parts[0]!
    }
  }
  throw new Error(
    `Checksum not found for "${target}" in checksums.sha256.\n` +
      "The checksums file may be from a different release.",
  )
}

// ---------------------------------------------------------------------------
// Streaming download with progress bar
// ---------------------------------------------------------------------------

async function streamToFileWithProgress(url: string, destPath: string): Promise<void> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Failed to download from ${url}: HTTP ${resp.status}`)
  if (!resp.body) throw new Error("Response body is null")

  const totalStr = resp.headers.get("content-length")
  const total = totalStr ? parseInt(totalStr, 10) : null
  let downloaded = 0

  const file = createWriteStream(destPath)
  const reader = resp.body.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      await new Promise<void>((res, rej) => {
        file.write(value, (err) => (err ? rej(err) : res()))
      })
      downloaded += value.length

      if (total && process.stdout.isTTY) {
        const pct = Math.min(100, Math.floor((downloaded / total) * 100))
        const filled = Math.floor(pct / 5)
        const bar = "=".repeat(filled).padEnd(20)
        process.stdout.write(
          `\r  [${bar}] ${pct}%  ${(downloaded / 1_000_000).toFixed(1)} / ${(total / 1_000_000).toFixed(1)} MB`,
        )
      }
    }

    if (total && process.stdout.isTTY) process.stdout.write("\n")

    await new Promise<void>((res, rej) => {
      file.end((err?: Error | null) => (err ? rej(err) : res()))
    })
  } catch (err) {
    file.destroy()
    throw err
  }
}

// ---------------------------------------------------------------------------
// SHA256 verification
// ---------------------------------------------------------------------------

const EXECUTABLE_COMPONENTS = new Set<Component>(["engine", "server", "deno", "realtime"])

/** True when a cached file matches expected format for the current platform. */
function cachedArtifactLooksValid(component: Component, filePath: string): boolean {
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size < 64) return false
    assertArtifactFormat(component, filePath, currentPlatform())
    return true
  } catch {
    return false
  }
}

/** Confirm a downloaded/cached artifact matches the expected CDN format (tests, CI). */
export function validateArtifactFormat(
  component: Component,
  filePath: string,
  platform: PlatformId,
): void {
  assertArtifactFormat(component, filePath, platform)
}

/**
 * Per-component CDN artifact shapes:
 *   engine, server, deno, realtime — native executable (ELF / Mach-O / PE)
 *   postgres (unix)      — .tar.gz (gzip)
 *   postgres (windows)   — .zip
 */
function assertArtifactFormat(
  component: Component,
  filePath: string,
  platform: PlatformId,
): void {
  if (component === "postgres") {
    if (platform.os === "windows") assertZipArchive(filePath)
    else assertGzipArchive(filePath)
    return
  }
  if (EXECUTABLE_COMPONENTS.has(component)) {
    assertNativeExecutable(filePath, component, platform)
    return
  }
}

/** Reject HTML/error pages or corrupt postgres .tar.gz on CDN. */
function assertGzipArchive(filePath: string): void {
  const fd = openSync(filePath, "r")
  try {
    const magic = Buffer.alloc(2)
    readSync(fd, magic, 0, 2, 0)
    if (magic[0] !== 0x1f || magic[1] !== 0x8b) {
      throw new Error(
        "Downloaded postgres file is not a gzip archive (bad magic bytes). " +
          "The CDN object may be corrupt or cached HTML — delete ~/.supatype/cache and retry.",
      )
    }
  } finally {
    closeSync(fd)
  }
}

/** Reject corrupt postgres .zip on CDN (Windows bundles). */
function assertZipArchive(filePath: string): void {
  const fd = openSync(filePath, "r")
  try {
    const magic = Buffer.alloc(4)
    readSync(fd, magic, 0, 4, 0)
    if (magic[0] !== 0x50 || magic[1] !== 0x4b) {
      throw new Error(
        "Downloaded postgres file is not a zip archive (bad magic bytes). " +
          "The CDN object may be corrupt or cached HTML — delete ~/.supatype/cache and retry.",
      )
    }
  } finally {
    closeSync(fd)
  }
}

/** Reject HTML/error pages, Go c-archives, or wrong-OS executables on CDN. */
function assertNativeExecutable(
  filePath: string,
  component: Component,
  platform: PlatformId,
): void {
  const fd = openSync(filePath, "r")
  try {
    const magic = Buffer.alloc(4)
    readSync(fd, magic, 0, 4, 0)
    const goCArchive =
      magic[0] === 0x21 && magic[1] === 0x3c && magic[2] === 0x61 && magic[3] === 0x72
    if (goCArchive) {
      throw new Error(
        `Downloaded ${component} file is a Go static archive (c-archive), not an executable. ` +
          "The CDN object may be from a bad release build — delete ~/.supatype/cache and retry.",
      )
    }
    if (platform.os === "windows") {
      if (magic[0] !== 0x4d || magic[1] !== 0x5a) {
        throw new Error(
          `Downloaded ${component} file is not a Windows PE executable (bad magic bytes). ` +
            "The CDN object may be corrupt or cached HTML — delete ~/.supatype/cache and retry.",
        )
      }
      return
    }
    if (platform.os === "linux") {
      const elf =
        magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46
      if (!elf) {
        throw new Error(
          `Downloaded ${component} file is not an ELF executable (bad magic bytes). ` +
            "The CDN object may be corrupt or cached HTML — delete ~/.supatype/cache and retry.",
        )
      }
      return
    }
    const macho =
      magic.readUInt32BE(0) === 0xfe_ed_fa_ce ||
      magic.readUInt32BE(0) === 0xfe_ed_fa_cf ||
      magic.readUInt32LE(0) === 0xfe_ed_fa_ce ||
      magic.readUInt32LE(0) === 0xfe_ed_fa_cf ||
      magic.readUInt32BE(0) === 0xca_fe_ba_be
    if (!macho) {
      throw new Error(
        `Downloaded ${component} file is not a Mach-O executable (bad magic bytes). ` +
          "The CDN object may be corrupt or cached HTML — delete ~/.supatype/cache and retry.",
      )
    }
  } finally {
    closeSync(fd)
  }
}

async function verifyChecksum(filePath: string, expected: string, component: Component): Promise<void> {
  const data = readFileSync(filePath)
  const actual = createHash("sha256").update(data).digest("hex")
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${component}.\n` +
        `  Expected: ${expected}\n` +
        `  Got:      ${actual}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff
// ---------------------------------------------------------------------------

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === attempts) throw err
      const delay = Math.pow(3, i - 1) * 1_000 // 1 s, 3 s, 9 s
      console.error(
        `[supatype] Download attempt ${i}/${attempts} failed: ${(err as Error).message}. ` +
          `Retrying in ${delay / 1_000}s...`,
      )
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw new Error("unreachable")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * On Windows, Git Bash represents paths as /c/Users/... — convert to C:\Users\...
 */
export function normalisePlatformPath(p: string): string {
  let result = p
  if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(result)) {
    result = result
      .replace(/^\/([a-zA-Z])\//, (_, drive: string) => `${drive.toUpperCase()}:\\`)
      .replace(/\//g, "\\")
  }
  if (process.platform === "win32" && !/\.\w+$/.test(result) && !existsSync(result)) {
    const withExe = result + ".exe"
    if (existsSync(withExe)) return withExe
  }
  return result
}

export function pinnedVersion(component: Component, config: SupatypeProjectConfig): string | undefined {
  const version = config.versions?.[component]
  if (typeof version !== "string") return undefined
  const trimmed = version.trim()
  return trimmed === "" ? undefined : trimmed
}

/** Pinned version from config, or latest from CDN when unset. */
export async function resolveVersionFor(
  component: Component,
  config: SupatypeProjectConfig,
): Promise<string> {
  const pinned = pinnedVersion(component, config)
  if (pinned) return pinned
  return fetchLatestVersion(component)
}

/** @deprecated Prefer {@link pinnedVersion} or {@link resolveVersionFor}. */
export function versionFor(component: Component, config: SupatypeProjectConfig): string {
  const version = pinnedVersion(component, config)
  if (!version) {
    throw new Error(
      `[supatype] versions.${component} is not pinned in supatype.config.ts (omit versions to use latest)`,
    )
  }
  return version
}

// ---------------------------------------------------------------------------
// Latest version resolution from CDN
// ---------------------------------------------------------------------------

/**
 * Fetch the latest available version for a component.
 * Each component directory on the CDN exposes `latest.json` → `{"version":"x.y.z"}`.
 */
export async function fetchLatestVersion(component: Component): Promise<string> {
  const url = `${CDN_BASE}/${component}/latest.json`
  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`Failed to fetch latest version for ${component} from ${url}: HTTP ${resp.status}`)
  }
  const data = await resp.json() as { version?: unknown }
  if (typeof data.version !== "string" || data.version.trim() === "") {
    throw new Error(`Invalid latest.json for ${component}: missing "version" field`)
  }
  return data.version.trim()
}

/** Fetch the latest version for all components concurrently. Missing CDN entries are omitted. */
export async function fetchAllLatestVersions(): Promise<Partial<Record<Component, string>>> {
  const results = await Promise.all(
    BINARY_COMPONENTS.map(async (c) => {
      try {
        return [c, await fetchLatestVersion(c)] as const
      } catch {
        return [c, undefined] as const
      }
    }),
  )
  const out: Partial<Record<Component, string>> = {}
  for (const [c, v] of results) {
    if (v) out[c] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// Download all components (used by postinstall + supatype update)
// ---------------------------------------------------------------------------

/**
 * Download all component binaries for the current platform.
 * Skips components that are already cached.
 * Fails gracefully when graceful=true (suitable for postinstall).
 */
/**
 * Verify all cached binaries for the current platform (used by integration CI).
 * Throws if any cached component is missing or fails format checks.
 */
export function verifyCachedBinaries(versions: Partial<ComponentVersions> | undefined): void {
  if (!versions) {
    throw new Error("[supatype] verifyCachedBinaries requires pinned versions")
  }
  const platform = currentPlatform()
  for (const component of BINARY_COMPONENTS) {
    const version = versions[component]
    if (typeof version !== "string" || version.trim() === "") {
      throw new Error(`[supatype] versions.${component} must be set`)
    }
    const destPath = join(cachePath(component, version), binaryName(component, version, platform))
    if (!cachedArtifactLooksValid(component, destPath)) {
      throw new Error(
        `[supatype] Cached ${component} v${version} is missing or invalid at ${destPath}. ` +
          "Run: supatype update (or delete ~/.supatype/cache and retry).",
      )
    }
  }
}

export async function downloadAll(
  versions: Partial<ComponentVersions> | undefined,
  graceful = false,
): Promise<void> {
  const platform = currentPlatform()
  const components: Component[] = [...BINARY_COMPONENTS]
  const latest = await fetchAllLatestVersions()

  for (const component of components) {
    const version = versions?.[component] ?? latest[component]
    if (!version || version === VERSION_PIN_LOCAL) continue
    try {
      await download(component, version, platform)
    } catch (err) {
      const msg = `[supatype] Failed to download ${component}: ${(err as Error).message}`
      if (graceful) {
        console.error(msg)
      } else {
        throw new Error(msg)
      }
    }
  }
}
