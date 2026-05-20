/**
 * Resolve component binaries, downloading from the CDN when not cached.
 */

import {
  resolveBinary,
  download,
  currentPlatform,
  versionFor,
  type Component,
} from "./binary-cache.js"
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

  return download(component, versionFor(component, config), currentPlatform())
}
