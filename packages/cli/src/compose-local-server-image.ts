import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { askDockerSync, NO_DOCKER_LIMIT } from "./docker-exec.js"
import { VERSION_PIN_LOCAL } from "./binary-cache.js"
import { appendStackOutput, getActiveDevSession } from "./dev-session.js"
import { requireDockerDaemon } from "./docker-runtime.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import { RELEASE_IMAGES } from "./release-images.js"

/** Docker tag for compose dev when `versions.server` is `local`. */
export const LOCAL_SERVER_DOCKER_IMAGE = "supatype/server:local-dev"

/** Find the server repo root (directory containing `Dockerfile`) from an overrides.server binary path. */
export function resolveServerSourceRoot(serverOverride: string, cwd: string): string | null {
  const binaryPath = isAbsolute(serverOverride) ? serverOverride : resolve(cwd, serverOverride)
  let dir = dirname(binaryPath)
  for (let depth = 0; depth < 5; depth++) {
    if (existsSync(join(dir, "Dockerfile"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Whether this project's compose stack should run the locally built server image.
 *
 * Synchronous and cheap, so any code path that writes `.env` can ask rather than being handed the
 * answer. It used to be handed down as an argument from the one path that built the image, and the
 * four paths that did not know about it wrote `.env` without `SUPATYPE_SERVER_IMAGE` while still
 * asking for unpinned image keys to be cleaned up. Each of those removed the key `dev` had just
 * written, so `overrides.server` held only until the next `push`, after which compose silently
 * recreated the container from the published image and the local build was not running at all.
 */
export function usesLocalServerImage(cwd: string, config: SupatypeProjectConfig): boolean {
  if (config.versions?.server !== VERSION_PIN_LOCAL) return false
  const override = config.overrides?.server?.trim()
  if (!override) return false
  return resolveServerSourceRoot(override, cwd) !== null
}

/**
 * When `versions.server` is `local`, build a Linux server image from the source tree
 * next to `overrides.server` so compose dev matches the contributor's binary.
 */
export async function ensureLocalServerDockerImage(
  cwd: string,
  config: SupatypeProjectConfig,
  brand?: { intro?: string },
): Promise<string | undefined> {
  if (config.versions?.server !== VERSION_PIN_LOCAL) return undefined

  const override = config.overrides?.server?.trim()
  if (!override) return undefined

  const root = resolveServerSourceRoot(override, cwd)
  if (!root) {
    console.warn(
      `[supatype] ⚠  versions.server is "local" but no Dockerfile found near ${override}. ` +
        `Compose will use this release's server image, ${RELEASE_IMAGES.server}.`,
    )
    return undefined
  }

  requireDockerDaemon(brand?.intro ? { brand: { intro: brand.intro } } : undefined)
  const dockerfile = join(root, "Dockerfile")
  console.log(`[supatype] Building local server Docker image from ${root}…`)
  // No limit: a build the person started and watches, as long as the Dockerfile makes it.
  const result = askDockerSync(["build", "--progress=plain", "-t", LOCAL_SERVER_DOCKER_IMAGE, "-f", dockerfile, root], {
    timeoutMs: NO_DOCKER_LIMIT,
  })
  const tui = getActiveDevSession()?.isTui() ?? false
  if (!tui) {
    appendStackOutput(result.stdout, "log")
    appendStackOutput(result.stderr, result.status === 0 ? "log" : "error")
  } else if (result.status !== 0) {
    appendStackOutput(result.stderr || result.stdout || "docker build failed", "error")
  }
  if (result.status !== 0) {
    throw new Error(`docker build failed for local server (exit ${result.status ?? "unknown"})`)
  }
  console.log(`[supatype] Local server image ready: ${LOCAL_SERVER_DOCKER_IMAGE}`)
  return LOCAL_SERVER_DOCKER_IMAGE
}
