/**
 * One rule for every command that needs the project's local Docker stack (issue 41, Nic's decision):
 * while that stack is not running, the command refuses before it does anything, with the one
 * message {@link NoStackRunning} carries. Nothing starts Postgres or the stack implicitly any more;
 * `push` started the whole stack and `diff` started Postgres. A linked target, `--connection`, a
 * `connection` in the config and an external database are reached as they are.
 */
import { runningStackMode } from "./compose-render-mode.js"
import { isLocalDatabaseUrl } from "./db-port.js"
import { NoStackRunning } from "./host-database.js"
import { loadProjectLink } from "./link.js"
import { resolveRuntimeProvider, usesExternalDatabase, type SupatypeProjectConfig } from "./project-config.js"

/** How a command was told to reach its database: one named for this run, and whether it skips the link. */
export interface StackRoute {
  connection?: string | undefined
  /** `--direct` or `--local`, or a command that always reaches the database itself (seed, migrate). */
  direct?: boolean | undefined
}

/**
 * Whether a command run with `connection` works on this project's own local Docker stack: a Docker
 * project whose database is the stack's, with no database named for this run. A `DATABASE_URL` in
 * the environment that names another machine is a database named too.
 */
export function reachesLocalStack(config: SupatypeProjectConfig, connection?: string): boolean {
  if (resolveRuntimeProvider(config) !== "docker" || usesExternalDatabase(config)) return false
  if (connection?.trim() || config.connection?.trim()) return false
  const shell = process.env["DATABASE_URL"]?.trim()
  return shell === undefined || shell === "" || isLocalDatabaseUrl(shell)
}

/**
 * Refuse `supatype <command>` with {@link NoStackRunning} when it would reach the project's local
 * stack and no stack runs for it: no `supatype dev` session and no server container. A linked
 * project goes to its link unless `route.direct` or a connection says otherwise.
 */
export function requireLocalStack(cwd: string, config: SupatypeProjectConfig, command: string, route: StackRoute = {}): void {
  const named = Boolean(route.connection?.trim())
  if (loadProjectLink(cwd) !== null && route.direct !== true && !named) return
  if (!reachesLocalStack(config, route.connection)) return
  if (runningStackMode(cwd, config.project.name) === undefined) throw new NoStackRunning(command)
}
