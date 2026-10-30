/**
 * Resolve component binaries, downloading from the CDN when not cached.
 */

import {
  resolveBinary,
  download,
  currentPlatform,
  resolveVersionFor,
  isCachedBinaryReady,
  hasEngineOverride,
  pinnedVersion,
  type Component,
} from "./binary-cache.js"
import { assertEngineVersionSupported } from "./engine-floor.js"
import { isDownloadInProgress, waitForComponentDownload } from "./binary-download-lock.js"
import { currentLibc } from "./cli-artifacts.js"
import { errorMessage } from "./error-message.js"
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

/**
 * Refuse an engine older than this CLI needs before it is resolved or downloaded (engine-floor.ts):
 * the pin, else the engine this CLI build pins. `overrides.engine` is the developer's own build.
 */
async function assertEngineSupported(config: SupatypeProjectConfig): Promise<void> {
  if (hasEngineOverride(config)) return
  const from = pinnedVersion("engine", config) !== undefined ? "versions.engine in supatype.config.ts" : "the engine this CLI build pins"
  assertEngineVersionSupported(await resolveVersionFor("engine", config), from, "binary")
}

export async function ensureBinary(
  component: Component,
  config: SupatypeProjectConfig,
): Promise<string> {
  if (component === "engine") await assertEngineSupported(config)
  try {
    return await resolveBinary(component, config)
  } catch (err) {
    const message = errorMessage(err)
    if (!message.includes("not found in cache")) {
      throw err
    }
  }

  try {
    return await fetchBinary(component, config)
  } catch (err) {
    throw new BinaryUnavailable(errorMessage(err), { cause: err })
  }
}

/**
 * A component the cache does not hold and that could not be fetched: the download failed, or this
 * platform or libc has no build. Told apart from a refusal or a config error, which are thrown as
 * they are, so a caller with another way to run the component (generated-files-engine.ts) takes it
 * only for this. The message is the cause's own.
 */
export class BinaryUnavailable extends Error {
  override readonly name = "BinaryUnavailable"
}

/** Download `component` at the version the project resolves to, or wait for a download in progress. */
async function fetchBinary(component: Component, config: SupatypeProjectConfig): Promise<string> {
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

  return (await download(component, version, platform)).path
}
