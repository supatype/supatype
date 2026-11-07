/**
 * What the local stack is actually running, asked of Docker rather than guessed.
 *
 * `status` and `logs` each used to carry a hardcoded list of container names.
 * Both lists were wrong: they named containers the compose file does not create
 * (`supatype-postgres`, `supatype-kong`), omitted every service it does create
 * (`server`, `storage`, `functions-worker`, `schema-engine`, and `valkey` when the
 * stack runs one), and used
 * a naming scheme the compose file never applies, since it sets no
 * `container_name` and Docker therefore names containers
 * `<project>-<service>-<n>`.
 *
 * A list of services in the source is a list that goes stale the next time the
 * stack changes shape. `docker compose ps` cannot.
 */
import { isJsonObject, parseJsonObject } from "@supatype/shared"
import { existsSync } from "node:fs"
import { loadConfig } from "./config.js"
import { askDocker, DOCKER_QUERY_TIMEOUT_MS } from "./docker-exec.js"
import { spawnFailureText } from "./error-message.js"
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
  /** The host ports among them, as numbers. */
  hostPorts: number[]
  /** How long it has been up, as Docker reports it. */
  status: string
  /** The container's last exit code, when Docker reports one. */
  exitCode?: number
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
export async function composeServices(ctx: ComposeContext): Promise<ComposeService[]> {
  const result = await askDocker([...composeArgs(ctx), "ps", "--all", "--format", "json"], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS })
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
      if (Array.isArray(parsed)) rows.push(...(parsed as unknown[]))
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
    if (!isJsonObject(row)) continue
    const record = row
    const service = typeof record["Service"] === "string" ? record["Service"] : ""
    if (service === "") continue
    services.push({
      service,
      container: typeof record["Name"] === "string" ? record["Name"] : "",
      state: typeof record["State"] === "string" ? record["State"] : "unknown",
      ports: typeof record["Publishers"] === "string" ? record["Publishers"] : formatPorts(record["Publishers"]),
      hostPorts: publications(record["Publishers"]).map((published) => published.host),
      status: typeof record["Status"] === "string" ? record["Status"] : "",
      ...(typeof record["ExitCode"] === "number" && { exitCode: record["ExitCode"] }),
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
  return [...new Set(publications(publishers).map(({ host, target }) => `${host}->${target}`))].join(", ")
}

/** Each host port in Compose's structured Publishers array, with the container port it maps to. */
function publications(publishers: unknown): Array<{ host: number; target: number }> {
  if (!Array.isArray(publishers)) return []
  return publishers.flatMap((entry: unknown) => {
    if (!isJsonObject(entry)) return []
    const host = entry["PublishedPort"]
    const target = entry["TargetPort"]
    return typeof host === "number" && host > 0 && typeof target === "number" ? [{ host, target }] : []
  })
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
export async function composeServiceNames(ctx: ComposeContext): Promise<string[]> {
  const result = await askDocker([...composeArgs(ctx), "config", "--services"], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS })
  if (result.status !== 0 || !result.stdout) return []
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .sort()
}

/** One compose service and the image it runs. */
export interface ServiceImage {
  service: string
  image: string
}

/**
 * Each service the compose file defines and the image it runs, as compose resolves the file, `.env`
 * included. Throws when compose cannot read the file: an empty list would read as nothing to pull.
 */
export async function composeServiceImages(ctx: ComposeContext): Promise<ServiceImage[]> {
  return Object.entries(await composeConfigServices(ctx))
    .flatMap(([service, spec]) =>
      isJsonObject(spec) && typeof spec["image"] === "string" ? [{ service, image: spec["image"] }] : [],
    )
    .sort((a, b) => a.service.localeCompare(b.service))
}

/** The `services` of the compose file as compose resolves it, `.env` included. Throws when it cannot read it. */
async function composeConfigServices(ctx: ComposeContext): Promise<Record<string, unknown>> {
  const result = await askDocker([...composeArgs(ctx), "config", "--format", "json"], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS })
  if (result.status !== 0) {
    throw new Error(`docker compose could not read ${ctx.composePath}: ${spawnFailureText({ ...result, stdout: "" })}`)
  }
  const parsed = parseJsonObject(result.stdout)
  if (!parsed.ok) {
    throw new Error(`docker compose config for ${ctx.composePath} answered with something that is not JSON (${parsed.error})`)
  }
  const services = parsed.value["services"]
  return isJsonObject(services) ? services : {}
}

/** A host port the compose file publishes, and the service it publishes it for. */
export interface PublishedPort {
  service: string
  port: number
}

/** The host ports the compose file publishes, as compose resolves it. Throws when it cannot read it. */
async function composePublishedPorts(ctx: ComposeContext): Promise<PublishedPort[]> {
  return Object.entries(await composeConfigServices(ctx)).flatMap(([service, spec]) => {
    const ports = isJsonObject(spec) && Array.isArray(spec["ports"]) ? spec["ports"] : []
    return ports.flatMap((entry: unknown) => {
      const port = isJsonObject(entry) ? Number(entry["published"]) : Number.NaN
      return Number.isInteger(port) && port > 0 ? [{ service, port }] : []
    })
  })
}

/**
 * The ports the compose file publishes that something other than this stack holds: `up` would fail
 * on each with Docker's "port is already allocated", after starting some containers (issue 57). A
 * port one of the stack's own running containers publishes is its own, not taken.
 */
export async function takenComposePorts(
  ctx: ComposeContext,
  inUse: (port: number) => Promise<boolean>,
): Promise<PublishedPort[]> {
  const [published, services] = await Promise.all([composePublishedPorts(ctx), composeServices(ctx)])
  const own = new Set(services.filter((s) => s.state === "running").flatMap((s) => s.hostPorts))
  const candidates = published.filter((entry) => !own.has(entry.port))
  // Each probe can wait out a connect timeout, so they run side by side.
  const busy = await Promise.all(candidates.map((entry) => inUse(entry.port)))
  return candidates.filter((_, index) => busy[index] === true)
}
