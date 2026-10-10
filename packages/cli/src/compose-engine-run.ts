/**
 * The schema engine run once in a stack's compose `tools` profile.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { dockerEnv } from "./docker-env.js"

/** Which stack, and the engine image to run in it (none: the compose file's default). */
export interface ComposeEngineTarget {
  cwd: string
  project: string
  composePath: string
  engineImage: string | undefined
}

/** How one run is started, beyond the engine's own arguments. */
export interface ComposeEngineSpawn {
  /** Flags for `docker compose run` before the service name, such as `-T` or `--no-deps`. */
  runFlags?: readonly string[]
  /** Variables for the engine, each a bare `-e NAME` with its value in docker's environment. */
  secrets?: Record<string, string>
  maxBuffer?: number
}

/**
 * `docker compose run --rm schema-engine ...engineArgs` in `target`'s `tools` profile.
 *
 * A value in `spawn.secrets`, such as the database URL with its password, never reaches docker's
 * command line, where any local user could read it from the process list.
 */
export function spawnComposeEngine(
  target: ComposeEngineTarget,
  engineArgs: readonly string[],
  spawn: ComposeEngineSpawn = {},
): SpawnSyncReturns<string> {
  const { cwd, project, composePath, engineImage } = target
  const envFile = resolve(cwd, ".env")
  const args = ["compose", "--progress", "quiet"]
  if (project) args.push("-p", project)
  args.push("--project-directory", cwd, "-f", composePath)
  if (existsSync(envFile)) args.push("--env-file", envFile)
  const secrets = dockerEnv(spawn.secrets ?? {}, { ...process.env, COMPOSE_PROGRESS: "quiet" })
  if (engineImage) secrets.env["SUPATYPE_ENGINE_IMAGE"] = engineImage
  args.push("--profile", "tools", "run", "--rm", ...(spawn.runFlags ?? []), ...secrets.args, "schema-engine")
  return spawnSync("docker", [...args, ...engineArgs], {
    cwd,
    encoding: "utf8",
    maxBuffer: spawn.maxBuffer ?? 10 * 1024 * 1024,
    env: secrets.env,
  })
}
