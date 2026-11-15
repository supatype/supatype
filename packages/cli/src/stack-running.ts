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
