/**
 * Postinstall script — downloads the correct engine binary for the current
 * platform and stores it at .definatype/engine/definatype-engine[.exe].
 *
 * Pattern: same as Prisma, esbuild, SWC, Turbo.
 */

import { createHash } from "node:crypto"
import { createWriteStream, mkdirSync, chmodSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { ENGINE_DOWNLOAD_BASE, ENGINE_VERSION } from "../engine-version.js"

const PLATFORM_MAP: Record<string, string> = {
  "darwin-arm64": "definatype-engine-macos-arm64",
  "darwin-x64": "definatype-engine-macos-x64",
  "linux-arm64": "definatype-engine-linux-arm64",
  "linux-x64": "definatype-engine-linux-x64",
  "win32-x64": "definatype-engine-windows-x64.exe",
}

async function main(): Promise<void> {
  const platform = process.platform
  const arch = process.arch
  const key = `${platform}-${arch}`
  const artifactName = PLATFORM_MAP[key]

  if (!artifactName) {
    console.warn(
      `[definatype] No prebuilt engine binary for ${key}. ` +
      `Build from source: https://github.com/${ENGINE_DOWNLOAD_BASE}`
    )
    return
  }

  // Destination: <project-root>/.definatype/engine/
  const projectRoot = findProjectRoot()
  const engineDir = join(projectRoot, ".definatype", "engine")
  mkdirSync(engineDir, { recursive: true })

  const binaryName = platform === "win32" ? "definatype-engine.exe" : "definatype-engine"
  const binaryPath = join(engineDir, binaryName)
  const checksumPath = `${binaryPath}.sha256`

  // Skip if already downloaded at the right version
  const versionMarker = join(engineDir, ".version")
  if (existsSync(versionMarker)) {
    const existing = (await import("node:fs/promises")).readFile(versionMarker, "utf8")
    if ((await existing).trim() === ENGINE_VERSION) {
      console.log(`[definatype] Engine v${ENGINE_VERSION} already installed.`)
      return
    }
  }

  const binaryUrl = `${ENGINE_DOWNLOAD_BASE}/${artifactName}`
  const checksumUrl = `${binaryUrl}.sha256`

  console.log(`[definatype] Downloading engine v${ENGINE_VERSION} for ${key}...`)

  await download(binaryUrl, binaryPath)
  await download(checksumUrl, checksumPath)

  await verifyChecksum(binaryPath, checksumPath, artifactName)

  if (platform !== "win32") {
    chmodSync(binaryPath, 0o755)
  }

  // Write version marker
  await (await import("node:fs/promises")).writeFile(versionMarker, ENGINE_VERSION)

  console.log(`[definatype] Engine installed at ${binaryPath}`)
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`)
  }
  const out = createWriteStream(dest)
  await pipeline(Readable.fromWeb(res.body!), out)
}

async function verifyChecksum(
  binaryPath: string,
  checksumPath: string,
  artifactName: string,
): Promise<void> {
  const fs = await import("node:fs/promises")
  const checksumFile = await fs.readFile(checksumPath, "utf8")
  const expectedHash = checksumFile.split(" ")[0]?.trim()
  if (!expectedHash) throw new Error("Invalid checksum file")

  const binaryData = await fs.readFile(binaryPath)
  const actualHash = createHash("sha256").update(binaryData).digest("hex")

  if (actualHash !== expectedHash) {
    throw new Error(
      `Checksum mismatch for ${artifactName}.\n` +
      `  Expected: ${expectedHash}\n` +
      `  Got:      ${actualHash}`
    )
  }
}

function findProjectRoot(): string {
  // Walk up from cwd until we find package.json
  let dir = process.cwd()
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return process.cwd() // fallback
    dir = parent
  }
}

main().catch((err) => {
  console.error("[definatype] Engine download failed:", err.message)
  console.error("[definatype] You can still use the CLI if you build the engine from source.")
  // Don't exit(1) — let npm install succeed even if binary download fails.
})
