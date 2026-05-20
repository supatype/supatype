/**
 * Binary cache — manages supatype component binaries.
 *
 * Components: engine, server, postgres, deno.
 * Cache root: ~/.supatype/cache/{component}/{version}/
 * Override path: config.overrides?.{component} (local build path).
 *
 * Security model:
 *   1. Download checksums.sha256 + checksums.sha256.minisig from CDN.
 *   2. Verify Ed25519 minisign signature on the checksum file using the
 *      embedded public key (SUPATYPE_RELEASE_PUBLIC_KEY).
 *   3. Verify SHA256 of the downloaded binary against the signed checksum.
 *   Both checks are mandatory when SUPATYPE_RELEASE_PUBLIC_KEY is set.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto"
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { chmod } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve, isAbsolute } from "node:path"
import type { SupatypeProjectConfig } from "./project-config.js"
import { releasePublicKey } from "./release-public-key.js"

/**
 * Set `versions.{engine|server|postgres|deno}: VERSION_PIN_LOCAL` to mean “use `overrides.*` only”
 * without duplicating the path string (Phase 10.7). Requires the matching `overrides` entry.
 */
export const VERSION_PIN_LOCAL = "local"

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
  add("studio", o.studio)
  add("postgrest", o.postgrest)
  return lines
}

/**
 * True when this working tree is associated with a remote Supatype Cloud project:
 * `project.ref`, `.supatype/cloud.json` (schema deploy link), or `.supatype/linked.json` (functions link).
 */
export function isLinkedToCloudProject(cwd: string, config: SupatypeProjectConfig): boolean {
  const ref = config.project.ref
  if (typeof ref === "string" && ref.trim() !== "") return true

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
import { BINARY_COMPONENTS, type Component } from "./components.js"

export interface PlatformId {
  os: "linux" | "darwin" | "windows"
  arch: "amd64" | "arm64"
}

// ---------------------------------------------------------------------------
// CDN base URL + release signing public key
// ---------------------------------------------------------------------------

const CDN_BASE = "https://releases.supatype.com"

/**
 * Supatype release signing public key (minisign format).
 * Generated with: minisign -G
 * Rotate by: generating a new pair, updating this constant, and updating
 * the MINISIGN_PRIVATE_KEY GitHub Actions secret.
 *
 * ⚠ PLACEHOLDER — replace with actual public key before first release.
 * When empty, minisign verification is skipped with a warning (SHA256 only).
 */
const SUPATYPE_RELEASE_PUBLIC_KEY = ""

// CDN path templates per component.
const CDN_PATHS: Record<Component, (version: string, platform: PlatformId) => string> = {
  engine:   (v, p) => `/engine/v${v}/supatype-engine-${p.os}-${p.arch}${p.os === "windows" ? ".exe" : ""}`,
  server:   (v, p) => `/server/v${v}/supatype-server-${p.os}-${p.arch}${p.os === "windows" ? ".exe" : ""}`,
  postgres: (v, p) => `/postgres/v${v}/supatype-pg-${v}-${p.os}-${p.arch}${p.os === "windows" ? ".zip" : ".tar.gz"}`,
  deno:     (v, p) => `/deno/v${v}/deno-${p.os}-${p.arch}${p.os === "windows" ? ".exe" : ""}`,
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

function binaryName(component: Component, version: string, platform: PlatformId): string {
  const win = platform.os === "windows"
  switch (component) {
    case "engine":   return `supatype-engine-${platform.os}-${platform.arch}${win ? ".exe" : ""}`
    case "server":   return `supatype-server-${platform.os}-${platform.arch}${win ? ".exe" : ""}`
    case "postgres": return `supatype-pg-${version}-${platform.os}-${platform.arch}${win ? ".zip" : ".tar.gz"}`
    case "deno":     return `deno-${platform.os}-${platform.arch}${win ? ".exe" : ""}`
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
  const version = versionFor(component, config)

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
    console.log(`[supatype] ${component} v${version} already cached.`)
    return destPath
  }

  const binaryUrl = `${CDN_BASE}${CDN_PATHS[component](version, platform)}`
  const checksumsUrl = `${CDN_BASE}${checksumsDirPath(component, version)}`
  const minisigUrl = `${checksumsUrl}.minisig`

  console.log(`[supatype] Downloading ${component} v${version} (${platform.os}/${platform.arch})...`)

  // ── Fetch checksums + optional minisig ────────────────────────────────────
  const expectedChecksum = await withRetry(() =>
    fetchChecksums(checksumsUrl, minisigUrl, name),
  )

  // ── Stream-download binary with progress ─────────────────────────────────
  const tmpPath = destPath + ".tmp"
  try {
    await withRetry(() => streamToFileWithProgress(binaryUrl, tmpPath))

    // ── Verify SHA256 ────────────────────────────────────────────────────────
    await verifyChecksum(tmpPath, expectedChecksum, component)

    writeFileSync(destPath, readFileSync(tmpPath))

    if (process.platform !== "win32") {
      await chmod(destPath, 0o755)
    }
  } finally {
    if (existsSync(tmpPath)) {
      try { require("node:fs").unlinkSync(tmpPath) } catch { /* ignore */ }
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
  if (pubKey) {
    // Minisign signature is required when a public key is embedded.
    const sigResp = await fetch(minisigUrl)
    if (!sigResp.ok) {
      throw new Error(
        `Failed to fetch checksum signature from ${minisigUrl}: HTTP ${sigResp.status}\n` +
          "Cannot verify release integrity. Aborting download.",
      )
    }
    const sigText = await sigResp.text()
    verifyMinisign(Buffer.from(checksumsText, "utf8"), sigText, pubKey)
  } else {
    console.warn(
      "[supatype] \u26a0  Minisign public key not configured — " +
        "skipping signature verification (SHA256 only).",
    )
  }

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
 * Verify a minisign signature (Ed25519 legacy mode, algorithm bytes "Ed").
 * Throws if verification fails.
 */
function verifyMinisign(fileBytes: Buffer, sigFileContent: string, pubKeyStr: string): void {
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

  // Only Ed25519 legacy mode ("Ed" = 0x45, 0x64) is supported.
  // Hashed mode ("ED") requires BLAKE2b prehashing — not implemented.
  if (algo[0] !== 0x45 || algo[1] !== 0x64) {
    throw new Error(
      "Unsupported minisign algorithm — only Ed25519 legacy mode supported.\n" +
        `Got: 0x${algo[0]?.toString(16)}${algo[1]?.toString(16)}`,
    )
  }

  if (!sigKeyId.equals(pkKeyId)) {
    throw new Error(
      "Minisign key ID mismatch — signature was produced with a different key.\n" +
        "This could indicate a compromised release. Do not proceed.",
    )
  }

  const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, pkEd25519])
  const keyObject = createPublicKey({ key: spkiDer, format: "der", type: "spki" })

  const valid = cryptoVerify(null, fileBytes, keyObject, signature)
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

export function versionFor(component: Component, config: SupatypeProjectConfig): string {
  const version = config.versions[component]
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`[supatype] versions.${component} must be set in supatype.config.ts`)
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

/** Fetch the latest version for all components concurrently. */
export async function fetchAllLatestVersions(): Promise<Record<Component, string>> {
  const results = await Promise.all(
    BINARY_COMPONENTS.map(async (c) => [c, await fetchLatestVersion(c)] as const),
  )
  return Object.fromEntries(results) as Record<Component, string>
}

// ---------------------------------------------------------------------------
// Download all components (used by postinstall + supatype update)
// ---------------------------------------------------------------------------

/**
 * Download all component binaries for the current platform.
 * Skips components that are already cached.
 * Fails gracefully when graceful=true (suitable for postinstall).
 */
export async function downloadAll(
  versions: SupatypeProjectConfig["versions"],
  graceful = false,
): Promise<void> {
  const platform = currentPlatform()
  const components: Component[] = [...BINARY_COMPONENTS]
  const fakeConfig = { versions } as SupatypeProjectConfig

  for (const component of components) {
    const version = versionFor(component, fakeConfig)
    if (version === VERSION_PIN_LOCAL) continue
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
