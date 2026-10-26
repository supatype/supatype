/**
 * The schema engine run once in a stack's compose `tools` profile.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { dockerEnv } from "./docker-env.js"
import { hasEnvValue } from "./env-file.js"

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
  const runFlags = spawn.runFlags ?? []
  const interpolation = runFlags.includes("--no-deps") ? unsetRequiredVariables(target) : {}
  const secrets = dockerEnv(spawn.secrets ?? {}, { ...process.env, ...interpolation, COMPOSE_PROGRESS: "quiet" })
  if (engineImage) secrets.env["SUPATYPE_ENGINE_IMAGE"] = engineImage
  args.push("--profile", "tools", "run", "--rm", ...runFlags, ...secrets.args, "schema-engine")
  return spawnSync("docker", [...args, ...engineArgs], {
    cwd,
    encoding: "utf8",
    maxBuffer: spawn.maxBuffer ?? 10 * 1024 * 1024,
    env: secrets.env,
  })
}
