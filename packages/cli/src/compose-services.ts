/**
 * What the local stack is actually running, asked of Docker rather than guessed.
 *
 * `status` and `logs` each used to carry a hardcoded list of container names.
 * Both lists were wrong: they named containers the compose file does not create
 * (`supatype-postgres`, `supatype-kong`), omitted every service it does create
 * (`server`, `storage`, `functions-worker`, `schema-engine`, `valkey`), and used
 * a naming scheme the compose file never applies, since it sets no
 * `container_name` and Docker therefore names containers
 * `<project>-<service>-<n>`.
 *
 * A list of services in the source is a list that goes stale the next time the
 * stack changes shape. `docker compose ps` cannot.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { loadConfig } from "./config.js"
import { composeProjectName, selfHostComposePaths } from "./self-host-compose.js"

/** Where the local stack's compose file is, and what project name it runs under. */
export interface ComposeContext {
  composePath: string
  projectRoot: string
  projectName: string
}

/** One service in the local stack. */
export interface ComposeService {
  /** The compose service name, which is what `logs --service` takes. */
  service: string
  /** The container Docker created for it, if any. */
  container: string
  /** Docker's own word: running, exited, created, restarting, and so on. */
  state: string
  /** Published ports, as Docker reports them. */
  ports: string
  /** How long it has been up, as Docker reports it. */
  status: string
}

/**
 * composeContext locates the generated compose file for this project.
 *
 * Returns undefined when the stack has never been generated, which is the
 * ordinary case in a project that only uses `supatype dev`.
 */
export function composeContext(cwd: string): ComposeContext | undefined {
  const paths = selfHostComposePaths(cwd)
  if (!existsSync(paths.composePath)) return undefined

  let projectName = "supatype"
  try {
    const config = loadConfig(cwd)
    if (config) projectName = composeProjectName(config.project.name)
  } catch {
    // A project whose config will not load can still have a running stack, and
    // reporting on it is more useful than refusing to.
  }
  return { composePath: paths.composePath, projectRoot: cwd, projectName }
}

/**
 * composeServices asks Docker what the stack is running.
 *
 * `--all` so a stopped service is reported as stopped rather than vanishing,
 * which is the question `supatype status` is usually asked.
 */
export function composeServices(ctx: ComposeContext): ComposeService[] {
  const result = spawnSync("docker", [...composeArgs(ctx), "ps", "--all", "--format", "json"], {
    encoding: "utf8",
    timeout: 15_000,
  })
  if (result.status !== 0 || !result.stdout) return []
  return parseComposePs(result.stdout)
}

/**
 * parseComposePs reads `docker compose ps --format json`.
 *
 * Compose v2 emits one JSON object per line; some versions emit a single JSON
 * array instead. Both are accepted, because which one you get depends on the
 * Docker version the developer happens to have.
 */
export function parseComposePs(stdout: string): ComposeService[] {
  const trimmed = stdout.trim()
  if (trimmed === "") return []

  const rows: unknown[] = []
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) rows.push(...parsed)
    } catch {
      return []
    }
  } else {
    for (const line of trimmed.split("\n")) {
      if (line.trim() === "") continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        // A line that is not JSON is progress noise, not a service.
      }
    }
  }

  const services: ComposeService[] = []
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue
    const record = row as Record<string, unknown>
    const service = typeof record["Service"] === "string" ? record["Service"] : ""
    if (service === "") continue
    services.push({
      service,
      container: typeof record["Name"] === "string" ? record["Name"] : "",
      state: typeof record["State"] === "string" ? record["State"] : "unknown",
      ports: typeof record["Publishers"] === "string" ? record["Publishers"] : formatPorts(record["Publishers"]),
      status: typeof record["Status"] === "string" ? record["Status"] : "",
    })
  }
  services.sort((a, b) => a.service.localeCompare(b.service))
  return services
}

/**
 * formatPorts renders the structured Publishers array Compose emits, keeping
 * only the ports actually reachable from the host.
 */
function formatPorts(publishers: unknown): string {
  if (!Array.isArray(publishers)) return ""
  const published: string[] = []
  for (const entry of publishers) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    const host = record["PublishedPort"]
    const target = record["TargetPort"]
    if (typeof host === "number" && host > 0 && typeof target === "number") {
      published.push(`${host}->${target}`)
    }
  }
  return [...new Set(published)].join(", ")
}

/**
 * composeArgs is the invocation prefix every compose call needs.
 *
 * The compose file lives under `.supatype/self-host/`, so the project directory
 * has to be given explicitly: without it Compose resolves relative build
 * contexts and env files against the file's own directory rather than the
 * project root.
 */
export function composeArgs(ctx: ComposeContext): string[] {
  return ["compose", "-p", ctx.projectName, "--project-directory", ctx.projectRoot, "-f", ctx.composePath]
}

/**
 * composeServiceNames lists the services the compose file defines.
 *
 * This is what `logs --service` should be validated against, not the running
 * containers: a service that failed to start is exactly the one whose logs you
 * want, and it has no container.
 */
export function composeServiceNames(ctx: ComposeContext): string[] {
  const result = spawnSync("docker", [...composeArgs(ctx), "config", "--services"], {
    encoding: "utf8",
    timeout: 15_000,
  })
  if (result.status !== 0 || !result.stdout) return []
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .sort()
}
