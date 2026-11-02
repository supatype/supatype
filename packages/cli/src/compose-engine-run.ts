/**
 * The schema engine run once in a stack's compose `tools` profile, or, for a run that needs no
 * database, its image alone.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { ENGINE_SERVICE } from "./compose-engine-service.js"
import { composeHostPath } from "./compose-host-path.js"
import { dockerEnv } from "./docker-env.js"
import { askDockerSync, NO_DOCKER_LIMIT, type DockerAnswer } from "./docker-exec.js"
import { readEnvFile } from "./env-file.js"

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
}

/**
 * `docker compose run --rm schema-engine ...engineArgs` in `target`'s `tools` profile. A `--no-deps`
 * run needs nothing else the stack runs, so it runs the image alone (`runEngineImageAlone`).
 *
 * A value in `spawn.secrets`, such as the database URL with its password, never reaches docker's
 * command line, where any local user could read it from the process list.
 */
export function spawnComposeEngine(
  target: ComposeEngineTarget,
  engineArgs: readonly string[],
  spawn: ComposeEngineSpawn = {},
): DockerAnswer {
  const { cwd, project, composePath, engineImage } = target
  const runFlags = spawn.runFlags ?? []
  if (runFlags.includes("--no-deps")) return runEngineImageAlone(target, engineArgs, spawn.secrets ?? {})
  const envFile = resolve(cwd, ".env")
  const args = ["compose", "--progress", "quiet"]
  if (project) args.push("-p", project)
  args.push("--project-directory", cwd, "-f", composePath)
  if (existsSync(envFile)) args.push("--env-file", envFile)
  const secrets = dockerEnv(spawn.secrets ?? {}, { ...process.env, COMPOSE_PROGRESS: "quiet" })
  if (engineImage) secrets.env[ENGINE_SERVICE.imageVariable] = engineImage
  args.push("--profile", "tools", "run", "--rm", ...runFlags, ...secrets.args, "schema-engine")
  // No limit: a push applies a schema the person is waiting on, and abandoning the client would
  // leave the `compose run` container applying it anyway. The callers are synchronous (engineRequest).
  return askDockerSync([...args, ...engineArgs], { cwd, env: secrets.env, timeoutMs: NO_DOCKER_LIMIT })
}

/**
 * The image `compose run` would use: the target's, else the one the shell or `.env` names, else the
 * compose file's default.
 */
function engineImageOf(target: ComposeEngineTarget): string {
  const named = (value: string | undefined): string | undefined => (value?.trim() ? value.trim() : undefined)
  return (
    named(target.engineImage) ??
    named(process.env[ENGINE_SERVICE.imageVariable]) ??
    named(readEnvFile(target.cwd)[ENGINE_SERVICE.imageVariable]) ??
    ENGINE_SERVICE.defaultImage
  )
}

/**
 * `docker run --rm` of the engine image as the compose service runs it (ENGINE_SERVICE), with no
 * network. `compose run --no-deps` still created the project's network and every volume the file
 * declares, and `generate` on a project whose stack had never run left them behind (local test round
 * 3c). It never reads the compose file, so the secrets a fresh clone's `.env` lacks do not matter.
 * The source is quoted, so a comma in the path is kept.
 */
function runEngineImageAlone(target: ComposeEngineTarget, engineArgs: readonly string[], vars: Record<string, string>): DockerAnswer {
  const { projectDir, entrypoint } = ENGINE_SERVICE
  const secrets = dockerEnv(vars)
  const mount = `type=bind,"source=${composeHostPath(target.cwd).replace(/"/g, '""')}",target=${projectDir}`
  const args = ["run", "--rm", "--network", "none", "--mount", mount, "--workdir", projectDir, "--entrypoint", entrypoint]
  return askDockerSync([...args, ...secrets.args, engineImageOf(target), ...engineArgs], {
    cwd: target.cwd,
    env: secrets.env,
    timeoutMs: NO_DOCKER_LIMIT,
  })
}
