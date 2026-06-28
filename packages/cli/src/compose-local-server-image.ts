import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { VERSION_PIN_LOCAL } from "./binary-cache.js"
import { appendStackOutput, getActiveDevSession } from "./dev-session.js"
import { requireDockerDaemon } from "./docker-runtime.js"
import type { SupatypeProjectConfig } from "./project-config.js"

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
        "Compose will use the default supatype/server:latest image.",
    )
    return undefined
  }

  requireDockerDaemon(brand?.intro ? { brand: { intro: brand.intro } } : undefined)
  const dockerfile = join(root, "Dockerfile")
  console.log(`[supatype] Building local server Docker image from ${root}…`)
  const result = spawnSync(
    "docker",
    ["build", "--progress=plain", "-t", LOCAL_SERVER_DOCKER_IMAGE, "-f", dockerfile, root],
    { encoding: "utf8", stdio: "pipe" },
  )
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
