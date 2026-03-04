/**
 * Locates the downloaded engine binary and provides a helper to invoke it.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { ENGINE_VERSION } from "./engine-version.js"

export function getEnginePath(): string {
  const projectRoot = findProjectRoot()
  const binaryName = process.platform === "win32" ? "definatype-engine.exe" : "definatype-engine"
  const path = join(projectRoot, ".definatype", "engine", binaryName)

  if (!existsSync(path)) {
    throw new Error(
      `Definatype engine binary not found at ${path}.\n` +
      `Run: npm install  (to trigger postinstall download)\n` +
      `Or build from source: https://github.com/definatype/definatype-schema-engine`
    )
  }

  return path
}

export interface EngineResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Invoke the engine binary with the given arguments.
 * Input JSON is passed via stdin.
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

function findProjectRoot(): string {
  let dir = process.cwd()
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return process.cwd()
    dir = parent
  }
}
