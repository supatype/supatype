/**
 * Postinstall script — downloads component binaries on first install.
 *
 * Components: supatype-engine, supatype-server, supatype-pg (Postgres), deno.
 * Binaries are cached in ~/.supatype/cache/{component}/{version}/.
 *
 * Failures are non-fatal: an installation message is printed and the user
 * can run `supatype update` manually to retry.
 */

import { download, currentPlatform, type Component } from "../binary-cache.js"
import { DENO_RELEASE_PIN } from "../release-pins.js"

// Default versions downloaded on fresh install.
// Updated by `supatype update` when new versions are released.
const DEFAULT_VERSIONS: Record<Component, string> = {
  engine: "0.4.2",
  server: "0.1.0",
  postgres: "17.2",
  deno: DENO_RELEASE_PIN,
}

async function main() {
  const platform = currentPlatform()
  console.log(`[supatype] Downloading component binaries for ${platform.os}/${platform.arch}...`)

  const components = Object.entries(DEFAULT_VERSIONS) as [Component, string][]

  let anyFailed = false
  for (const [component, version] of components) {
    try {
      await download(component, version, platform)
    } catch (err) {
      console.error(`[supatype] Failed to download ${component} v${version}: ${(err as Error).message}`)
      anyFailed = true
    }
  }

  if (anyFailed) {
    console.error("[supatype] Some downloads failed. Run 'supatype update' to retry.")
  } else {
    console.log("[supatype] All component binaries downloaded successfully.")
  }
}

main().catch((err) => {
  // Non-fatal — postinstall failures should not break npm install.
  console.error("[supatype] Postinstall failed:", err)
  process.exit(0)
})
