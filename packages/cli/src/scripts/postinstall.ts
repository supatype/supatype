/**
 * Postinstall script — downloads the correct engine binary for the current
 * platform and caches it at ~/.supatype/engine/{version}/supatype-engine[.exe].
 *
 * Pattern: same as Prisma, esbuild, SWC, Turbo.
 *
 * The binary is verified via:
 * 1. Minisign signature on checksums.sha256 (proves checksum file is authentic)
 * 2. SHA256 checksum of binary (proves binary matches signed checksum)
 */

import { ENGINE_VERSION } from "../engine-version.js"
import { detectPlatform } from "../engine/platform.js"
import { hasCachedBinary } from "../engine/cache.js"
import { resolveEngine } from "../engine/resolve.js"

async function main(): Promise<void> {
  const platform = detectPlatform()

  // Skip if already cached at the right version
  if (hasCachedBinary(ENGINE_VERSION, platform)) {
    console.log(`[supatype] Engine v${ENGINE_VERSION} already cached.`)
    return
  }

  console.log(
    `[supatype] Downloading engine v${ENGINE_VERSION} for ${platform.os}-${platform.arch}...`,
  )

  const result = await resolveEngine(ENGINE_VERSION)
  console.log(`[supatype] Engine installed at ${result.binaryPath}`)
}

main().catch((err) => {
  console.error("[supatype] Engine download failed:", err.message)
  console.error(
    "[supatype] You can still use the CLI — the engine will be downloaded on first use.",
  )
  // Don't exit(1) — let npm install succeed even if binary download fails.
})
