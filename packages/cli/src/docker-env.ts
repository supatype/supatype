/**
 * Environment for a container started or entered through the `docker` CLI, kept off its command line.
 *
 * `docker run -e NAME=value` and `docker exec -e NAME=value` (and their compose forms) put the
 * value on docker's argv, which any local user can read from the process list while the command
 * runs. A bare `-e NAME` makes docker read the value from its own environment instead, so the
 * values go there.
 */

/** The `-e` flags to put on docker's command line, and the environment to spawn docker with. */
export interface DockerEnv {
  args: string[]
  env: NodeJS.ProcessEnv
}

/** `-e NAME` for each of `vars`, with every value in the returned environment, on top of `base`. */
export function dockerEnv(
  vars: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): DockerEnv {
  return {
    args: Object.keys(vars).flatMap((name) => ["-e", name]),
    env: { ...base, ...vars },
  }
}
