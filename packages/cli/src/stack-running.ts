/**
 * Whether a compose stack has containers, for the commands that change one service of a running
 * stack. `self-host compose restart` recreates its service with `up --no-deps`, which on a stack
 * that is not running creates that service alone, with a database volume and networks for a stack
 * that does not exist.
 */
import { askDockerSync, DOCKER_QUERY_TIMEOUT_MS } from "./docker-exec.js"

/** The ids of `project`'s containers, one per line, or null when Docker cannot be asked. */
export type StackContainers = (project: string) => string | null

const dockerContainers: StackContainers = (project) => {
  const answer = askDockerSync(
    ["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${project}`],
    { timeoutMs: DOCKER_QUERY_TIMEOUT_MS },
  )
  return answer.status === 0 ? answer.stdout : null
}

/** Why `service` of `project` cannot be restarted, or null to go ahead. */
export function restartRefusal(service: string, project: string, containers: StackContainers = dockerContainers): string | null {
  const ids = containers(project)
  if (ids === null || ids.trim() !== "") return null
  return (
    `The stack ${project} is not running, so there is no ${service} to restart. ` +
    "Start it with: supatype self-host compose up"
  )
}

/**
 * What to say after restarting `service` when functions were given the stack's database
 * (`wantsDb`) but db, recreated only by `up`, is not on the functions network yet. `dbNetworks`
 * is null when Docker could not say.
 */
export function functionsNetworkNote(
  service: string,
  project: string,
  wantsDb: boolean,
  dbNetworks: readonly string[] | null,
): string | null {
  if (service !== "functions-worker" || !wantsDb || dbNetworks === null) return null
  if (dbNetworks.includes(`${project}_functions-db`)) return null
  return (
    "SUPATYPE_FUNCTIONS_DB_URL names db, but db joins the functions network only when it is recreated, " +
    "so ctx.dbUrl fails with `getaddrinfo ENOTFOUND db` until you run: supatype self-host compose up"
  )
}

/** The networks of `project`'s db container, or null when Docker cannot say. */
export function dbContainerNetworks(project: string): string[] | null {
  const answer = askDockerSync(
    ["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=db"],
    { timeoutMs: DOCKER_QUERY_TIMEOUT_MS },
  )
  const id = answer.status === 0 ? answer.stdout.trim().split("\n")[0] : undefined
  if (id === undefined || id === "") return null
  const inspect = askDockerSync(["inspect", "-f", "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}", id], {
    timeoutMs: DOCKER_QUERY_TIMEOUT_MS,
  })
  return inspect.status === 0 ? inspect.stdout.trim().split(/\s+/).filter((name) => name !== "") : null
}
