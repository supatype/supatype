/**
 * Resolve component binaries, downloading from the CDN when not cached.
 */

import {
  resolveBinary,
  download,
  currentPlatform,
  resolveVersionFor,
  isCachedBinaryReady,
  type Component,
} from "./binary-cache.js"
import { isDownloadInProgress, waitForComponentDownload } from "./binary-download-lock.js"
import type { SupatypeProjectConfig } from "./project-config.js"

export async function ensureBinary(
  component: Component,
  config: SupatypeProjectConfig,
): Promise<string> {
  try {
    return await resolveBinary(component, config)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes("not found in cache")) {
      throw err
    }
  }

  const version = await resolveVersionFor(component, config)
  const platform = currentPlatform()

  if (isDownloadInProgress(component, version)) {
    console.log(`[supatype] Waiting for in-progress ${component} download...`)
    const outcome = await waitForComponentDownload(
      component,
      version,
      () => isCachedBinaryReady(component, version, platform),
      (c) => {
        console.log(`[supatype] Still waiting for ${c}...`)
      },
    )
    if (outcome === "ready") {
      return resolveBinary(component, config)
    }
  }

  return download(component, version, platform)
}
