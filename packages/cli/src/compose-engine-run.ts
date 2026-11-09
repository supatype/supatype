/**
 * The schema engine run once in a stack's compose `tools` profile, or, for a run that needs no
 * database, its image alone.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { ENGINE_SERVICE } from "./compose-engine-service.js"
import { composeHostPath } from "./compose-host-path.js"
import { dockerEnv } from "./docker-env.js"
import { askDocker, askDockerSync, NO_DOCKER_LIMIT, type DockerAnswer, type DockerCall } from "./docker-exec.js"
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

/** The `docker` arguments of one engine run, and where it runs. */
interface EngineDockerCall {
  args: string[]
  call: DockerCall & { timeoutMs: typeof NO_DOCKER_LIMIT }
}

/**
 * `docker compose run --rm schema-engine ...engineArgs` in `target`'s `tools` profile. A `--no-deps`
 * run needs nothing else the stack runs, so it runs the image alone (`engineImageAloneCall`).
 * Asynchronous: run synchronously, a push held the dev dashboard and every process's output until
 * it was done.
 *
 * A value in `spawn.secrets`, such as the database URL with its password, never reaches docker's
 * command line, where any local user could read it from the process list.
 */
export function spawnComposeEngine(
  target: ComposeEngineTarget,
  engineArgs: readonly string[],
  spawn: ComposeEngineSpawn = {},
): Promise<DockerAnswer> {
  const { args, call } = engineDockerCall(target, engineArgs, spawn)
  return askDocker(args, call)
}

/**
 * {@link spawnComposeEngine} for the capability probe, which is synchronous all the way down and
 * asked once per engine image, so it never runs on a save.
 */
export function spawnComposeEngineSync(
  target: ComposeEngineTarget,
  engineArgs: readonly string[],
  spawn: ComposeEngineSpawn = {},
): DockerAnswer {
  const { args, call } = engineDockerCall(target, engineArgs, spawn)
  return askDockerSync(args, call)
}

/** The run as `docker` arguments: the image alone for a `--no-deps` run, else `compose run`. */
function engineDockerCall(target: ComposeEngineTarget, engineArgs: readonly string[], spawn: ComposeEngineSpawn): EngineDockerCall {
  const runFlags = spawn.runFlags ?? []
  if (runFlags.includes("--no-deps")) return engineImageAloneCall(target, engineArgs, spawn.secrets ?? {})
  return composeRunCall(target, engineArgs, spawn.secrets ?? {}, runFlags)
}

function composeRunCall(
  target: ComposeEngineTarget,
  engineArgs: readonly string[],
  vars: Record<string, string>,
  runFlags: readonly string[],
): EngineDockerCall {
  const { cwd, project, composePath, engineImage } = target
  const envFile = resolve(cwd, ".env")
  const args = ["compose", "--progress", "quiet"]
  if (project) args.push("-p", project)
  args.push("--project-directory", cwd, "-f", composePath)
  if (existsSync(envFile)) args.push("--env-file", envFile)
  const secrets = dockerEnv(vars, { ...process.env, COMPOSE_PROGRESS: "quiet" })
  if (engineImage) secrets.env[ENGINE_SERVICE.imageVariable] = engineImage
  args.push("--profile", "tools", "run", "--rm", ...runFlags, ...secrets.args, "schema-engine")
  // No limit: a push applies a schema the person is waiting on, and abandoning the client would
  // leave the `compose run` container applying it anyway.
  return { args: [...args, ...engineArgs], call: { cwd, env: secrets.env, timeoutMs: NO_DOCKER_LIMIT } }
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
function engineImageAloneCall(target: ComposeEngineTarget, engineArgs: readonly string[], vars: Record<string, string>): EngineDockerCall {
  const { projectDir, entrypoint } = ENGINE_SERVICE
  const secrets = dockerEnv(vars)
  const mount = `type=bind,"source=${composeHostPath(target.cwd).replace(/"/g, '""')}",target=${projectDir}`
  const args = ["run", "--rm", "--network", "none", "--mount", mount, "--workdir", projectDir, "--entrypoint", entrypoint]
  return {
    args: [...args, ...secrets.args, engineImageOf(target), ...engineArgs],
    call: { cwd: target.cwd, env: secrets.env, timeoutMs: NO_DOCKER_LIMIT },
  }
}
