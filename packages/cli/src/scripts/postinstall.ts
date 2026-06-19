/**
 * Postinstall script — downloads component binaries on first install.
 *
 * Components: supatype-engine, supatype-server, supatype-pg (Postgres), deno.
 * Binaries are cached in ~/.supatype/cache/{component}/{version}/.
 *
 * Failures are non-fatal: an installation message is printed and the user
 * can run `supatype update` manually to retry.
 */

import { download, currentPlatform, fetchAllLatestVersions, type Component } from "../binary-cache.js"

async function main() {
  const platform = currentPlatform()

  let versions: Record<Component, string>
  try {
    console.log("[supatype] Fetching latest component versions...")
    versions = await fetchAllLatestVersions()
  } catch (err) {
    console.error(`[supatype] Failed to fetch latest versions: ${(err as Error).message}`)
    console.error("[supatype] Run 'supatype update' to download component binaries.")
    return
  }

  console.log(`[supatype] Downloading component binaries for ${platform.os}/${platform.arch}...`)

  const components = Object.entries(versions) as [Component, string][]

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
    // npm hides postinstall output unless --foreground-scripts, so don't rely on
    // this being seen: the CLI re-attempts the download (with retry) on first use.
    console.error(
      "[supatype] Some component binaries failed to download. " +
        "They will be re-downloaded automatically on first use; " +
        "run 'supatype update' to retry now.",
    )
  } else {
    console.log("[supatype] All component binaries downloaded successfully.")
  }
}

main().catch((err) => {
  // Non-fatal — postinstall failures should not break npm install.
  console.error("[supatype] Postinstall failed:", err)
  process.exit(0)
})
