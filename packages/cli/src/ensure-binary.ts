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
import { currentLibc } from "./cli-artifacts.js"
import type { SupatypeProjectConfig } from "./project-config.js"

/**
 * Components are published for glibc only, so on Alpine the CLI itself runs (it has a musl
 * build) while everything it downloads cannot start. Said once, before the first download,
 * because the alternative is a dynamic loader error naming a file the user never asked for.
 */
let warnedAboutMusl = false
function warnIfMusl(component: Component): void {
  if (warnedAboutMusl || currentLibc() !== "musl") return
  warnedAboutMusl = true
  console.warn(
    `[supatype] This is a musl system (Alpine). Component binaries such as ${component} are ` +
      "published for glibc only, so they may fail to start here.\n" +
      "[supatype] Use a glibc image (for example node:22-bookworm) for local stacks, or run " +
      "against a remote target with `supatype link`.",
  )
}

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

  warnIfMusl(component)

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
