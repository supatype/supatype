/**
 * The schema engine run once in a stack's compose `tools` profile, or, for a run that needs no
 * database, its image alone.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { dockerEnv } from "./docker-env.js"
import { askDockerSync, NO_DOCKER_LIMIT, type DockerAnswer } from "./docker-exec.js"
import { hasEnvValue } from "./env-file.js"
import { composeHostPath } from "./compose-host-path.js"

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

/** What compose reads for a required variable that a `--no-deps` engine run never hands to a service. */
const UNUSED_BY_THIS_RUN = "unused-by-a-no-deps-engine-run"

/**
 * A value for each `${VAR:?}` the compose file requires and neither the shell nor `.env` sets.
 *
 * Compose interpolates the whole file before it runs one service, so a project whose `.env` `dev`
 * never prepared (a fresh clone, CI) could not generate types in its engine image: compose refused
 * over `JWT_SECRET`, which PostgREST and the server read and a `--no-deps` run starts neither of.
 * The engine service reads none of these, and they go nowhere else: not to `.env`, not to `-e`.
 * A run with its dependencies gets none, so a stack missing a secret still refuses to start.
 */
function unsetRequiredVariables(target: ComposeEngineTarget): Record<string, string> {
  if (!existsSync(target.composePath)) return {}
  const out: Record<string, string> = {}
  // `$${` is compose's escaped literal dollar, not a variable.
  for (const m of readFileSync(target.composePath, "utf8").matchAll(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*):\?/g)) {
    const name = m[1]
    if (name === undefined || process.env[name] || hasEnvValue(target.cwd, name)) continue
    out[name] = UNUSED_BY_THIS_RUN
  }
  return out
}

/**
 * `docker compose run --rm schema-engine ...engineArgs` in `target`'s `tools` profile. A `--no-deps`
 * run of a named image runs that image alone (`runEngineImageAlone`).
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
  if (engineImage && runFlags.includes("--no-deps")) return runEngineImageAlone(cwd, engineImage, engineArgs, spawn.secrets ?? {})
  const envFile = resolve(cwd, ".env")
  const args = ["compose", "--progress", "quiet"]
  if (project) args.push("-p", project)
  args.push("--project-directory", cwd, "-f", composePath)
  if (existsSync(envFile)) args.push("--env-file", envFile)
  const interpolation = runFlags.includes("--no-deps") ? unsetRequiredVariables(target) : {}
  const secrets = dockerEnv(spawn.secrets ?? {}, { ...process.env, ...interpolation, COMPOSE_PROGRESS: "quiet" })
  if (engineImage) secrets.env["SUPATYPE_ENGINE_IMAGE"] = engineImage
  args.push("--profile", "tools", "run", "--rm", ...runFlags, ...secrets.args, "schema-engine")
  // No limit: a push applies a schema the person is waiting on, and abandoning the client would
  // leave the `compose run` container applying it anyway. The callers are synchronous (engineRequest).
  return askDockerSync([...args, ...engineArgs], { cwd, env: secrets.env, timeoutMs: NO_DOCKER_LIMIT })
}

/**
 * `docker run --rm` of the engine image as the compose service runs it (the project at /project, the
 * engine as entrypoint), with no network. `compose run --no-deps` still created the project's
 * network and every volume the file declares, and `generate` on a project whose stack had never run
 * left them behind (local test round 3c). The source is quoted, so a comma in the path is kept.
 */
function runEngineImageAlone(
  cwd: string,
  image: string,
  engineArgs: readonly string[],
  vars: Record<string, string>,
): DockerAnswer {
  const secrets = dockerEnv(vars)
  const mount = `type=bind,"source=${composeHostPath(cwd).replace(/"/g, '""')}",target=/project`
  const args = ["run", "--rm", "--network", "none", "--mount", mount, "--workdir", "/project", "--entrypoint", "supatype-engine"]
  return askDockerSync([...args, ...secrets.args, image, ...engineArgs], { cwd, env: secrets.env, timeoutMs: NO_DOCKER_LIMIT })
}
