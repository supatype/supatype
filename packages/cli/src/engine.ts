/**
 * Locates the engine binary (from cache) and provides a helper to invoke it.
 *
 * The engine binary is cached at ~/.supatype/engine/{version}/supatype-engine[.exe].
 * On first use, it's automatically downloaded, verified, and cached.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { ENGINE_VERSION } from "./engine-version.js"
import { detectPlatform } from "./engine/platform.js"
import { getCachedBinaryPath, hasCachedBinary } from "./engine/cache.js"
import { resolveEngine, checkVersionCompatibility } from "./engine/resolve.js"

export interface EngineResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Get the path to the engine binary, downloading if needed.
 * This is the async version — use when you can await.
 */
export async function getEnginePathAsync(): Promise<string> {
  const platform = detectPlatform()

  // Fast path: binary already cached
  if (hasCachedBinary(ENGINE_VERSION, platform)) {
    return getCachedBinaryPath(ENGINE_VERSION, platform)
  }

  // Need to download
  const result = await resolveEngine(ENGINE_VERSION)
  return result.binaryPath
}

/**
 * Get the path to the engine binary (sync).
 * Throws if the binary is not cached — caller must ensure it's downloaded first.
 */
export function getEnginePath(): string {
  const platform = detectPlatform()
  const path = getCachedBinaryPath(ENGINE_VERSION, platform)

  if (!hasCachedBinary(ENGINE_VERSION, platform)) {
    throw new Error(
      `Supatype engine binary not found in cache.\n` +
      `Expected: ${path}\n` +
      `Run any supatype command to trigger automatic download,\n` +
      `or run: npx supatype engine version`,
    )
  }

  return path
}

/**
 * Ensure the engine binary is available, downloading if necessary.
 * Call this before invokeEngine() in command handlers.
 */
export async function ensureEngine(): Promise<string> {
  const result = await resolveEngine(ENGINE_VERSION)

  if (!result.fromCache) {
    // Just downloaded — version is correct
    return result.binaryPath
  }

  // Cached — check compatibility
  const compat = checkVersionCompatibility(ENGINE_VERSION, ENGINE_VERSION)
  if (!compat.compatible) {
    throw new Error(compat.message)
  }

  return result.binaryPath
}

/**
 * Invoke the engine binary with the given arguments.
 * Input JSON is passed via stdin.
 *
 * The caller must call ensureEngine() first to guarantee the binary exists.
 */
export function invokeEngine(
  args: string[],
  input?: string,
): EngineResult {
  const enginePath = getEnginePath()
  const result: SpawnSyncReturns<Buffer> = spawnSync(enginePath, args, {
    input: input ? Buffer.from(input, "utf8") : undefined,
    maxBuffer: 50 * 1024 * 1024, // 50MB
  })

  return {
    stdout: result.stdout?.toString("utf8") ?? "",
    stderr: result.stderr?.toString("utf8") ?? "",
    exitCode: result.status ?? 1,
  }
}
