/**
 * Kong and the containers it sends requests to.
 *
 * Kong reaches its upstreams (server, PostgREST, Studio) by service name, and resolves a name once
 * and keeps the answer: Docker's DNS gives it a 600 s TTL, and Kong serves a stale record while it
 * refreshes. A recreated container can come back on a new address, so after the CLI recreated the
 * server, sign-in through Kong answered 502 until Kong was restarted by hand (EXT-N1).
 *
 * Shortening Kong's DNS TTLs instead broke Studio from its dev server: `host.docker.internal` is a
 * hosts-file entry (`extra_hosts`), and with a 5 s TTL Kong dropped it and asked Docker's DNS,
 * which does not know it (CE1). So the TTLs are Kong's defaults, and a `docker compose up` the CLI
 * runs (`runDockerCompose`) is followed by `kong reload` when, and only when, it moved one of
 * Kong's upstreams to a new address under a Kong that was already running. A reload starts workers
 * with empty DNS caches and lets the old ones finish the requests they hold, but it also closes
 * their idle keep-alive connections, and a client that reuses one at that instant without retrying
 * sees it fail. So a reload is run only when an address Kong holds is actually stale.
 *
 * Kong is never restarted for this. A restart drops every request in flight, and the reload used to
 * fall back to one while Kong was still starting, which is every dev start (KONG-N1). A Kong the
 * `up` started or recreated resolves afresh on its own, so it is left alone.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { composeBaseArgs, type ComposeStack } from "./compose-db-psql.js"

/** How long a reload waits for a Kong that is still starting. */
const KONG_READY_WITHIN_MS = 60_000
const KONG_READY_POLL_MS = 500

/** One running container: its id, and the addresses it has on the stack's networks. */
export interface RunningContainer {
  id: string
  addresses: string
}

/** `docker inspect` line per container: its compose service, its id, then each network address. */
const INSPECT_FORMAT =
  '{{index .Config.Labels "com.docker.compose.service"}} {{.Id}}{{range .NetworkSettings.Networks}} {{.IPAddress}}{{end}}'

function compose(cwd: string, stack: ComposeStack, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("docker", [...composeBaseArgs(cwd, stack), ...args], { cwd, encoding: "utf8" })
}

/** True when the named compose service has a running container. */
export function composeServiceIsRunning(cwd: string, stack: ComposeStack, service: string): boolean {
  const result = compose(cwd, stack, ["ps", "-q", "--status", "running", service])
  return result.status === 0 && typeof result.stdout === "string" && result.stdout.trim() !== ""
}

/**
 * The running containers of `stack` by compose service, or undefined when docker could not say
 * (one gone between the listing and the inspect included). Listed by the compose project's label,
 * which needs no compose file parsed.
 */
function runningContainers(cwd: string, stack: ComposeStack): Map<string, RunningContainer> | undefined {
  const filter = `label=com.docker.compose.project=${stack.project}`
  const listed = spawnSync("docker", ["ps", "-q", "--filter", filter], { cwd, encoding: "utf8" })
  if (listed.status !== 0 || typeof listed.stdout !== "string") return undefined
  const ids = listed.stdout.split(/\s+/).filter((id) => id !== "")
  const containers = new Map<string, RunningContainer>()
  if (ids.length === 0) return containers
  const inspected = spawnSync("docker", ["inspect", "-f", INSPECT_FORMAT, ...ids], { cwd, encoding: "utf8" })
  if (inspected.status !== 0 || typeof inspected.stdout !== "string") return undefined
  for (const line of inspected.stdout.split(/\r?\n/)) {
    const [service, id, ...addresses] = line.trim().split(/\s+/)
    if (service && id) containers.set(service, { id, addresses: addresses.sort().join(" ") })
  }
  return containers
}

/**
 * The compose services Kong sends requests to, from the `url:` of each service in the `kong.yml`
 * rendered beside the compose file, or undefined when it cannot be read or names none (a format
 * this does not read is unknown, not "no upstreams"). Most routes go to the server; GraphQL goes to
 * PostgREST directly; Studio's dev server is on the host, not a service.
 */
function kongUpstreams(cwd: string, stack: ComposeStack): ReadonlySet<string> | undefined {
  let config: string
  try {
    config = readFileSync(resolve(cwd, dirname(stack.composePath), "kong.yml"), "utf8")
  } catch {
    return undefined
  }
  const hosts = new Set([...config.matchAll(/^\s*url:\s*["']?https?:\/\/([^:/"'\s]+)/gm)].map((m) => m[1]!))
  return hosts.size === 0 ? undefined : hosts
}

/**
 * Whether an `up` that turned `before` into `after` left a running Kong holding a stale address:
 * Kong was running before it and is the same container after it, and one of its `upstreams` is now
 * on an address it was not on before (recreated elsewhere, or newly running). A container recreated
 * on the address it had is still where Kong's cache says. Any service counts when the upstreams are
 * unknown, and a Kong known to be running is reloaded when either listing is: a needless reload
 * costs less than a stale address.
 */
export function kongNeedsReload(
  before: ReadonlyMap<string, RunningContainer> | undefined,
  after: ReadonlyMap<string, RunningContainer> | undefined,
  upstreams?: ReadonlySet<string>,
): boolean {
  if (before === undefined || after === undefined) return (after ?? before)?.has("kong") ?? false
  const kong = before.get("kong")
  if (kong === undefined || after.get("kong")?.id !== kong.id) return false
  const behindKong = (service: string) => service !== "kong" && (upstreams?.has(service) ?? true)
  return [...after].some(
    ([service, now]) => behindKong(service) && before.get(service)?.addresses !== now.addresses,
  )
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Wait until Kong answers `kong health`, for at most `withinMs`. True once it does. */
function waitKongHealthy(cwd: string, stack: ComposeStack, withinMs: number): boolean {
  const deadline = Date.now() + withinMs
  for (;;) {
    if (compose(cwd, stack, ["exec", "-T", "kong", "kong", "health"]).status === 0) return true
    if (Date.now() >= deadline) return false
    pause(KONG_READY_POLL_MS)
  }
}

function warnNotReloaded(stack: ComposeStack, why: string): false {
  console.warn(
    "[supatype] Kong could not be reloaded after a container behind it was recreated; requests through it may " +
      `fail until it is reloaded (docker compose -p ${stack.project} exec kong kong reload): ${why}`,
  )
  return false
}

/**
 * Have a running Kong resolve its upstreams again with `kong reload`. A Kong still starting cannot
 * take one, so a failed reload waits for Kong to be ready and tries once more. Never a restart:
 * that would drop the requests in flight. True when Kong reloaded.
 */
export function reloadKong(cwd: string, stack: ComposeStack, readyWithinMs = KONG_READY_WITHIN_MS): boolean {
  const reload = () => compose(cwd, stack, ["exec", "-T", "kong", "kong", "reload"])
  if (reload().status === 0) return true
  if (!waitKongHealthy(cwd, stack, readyWithinMs)) {
    return warnNotReloaded(stack, `it was not ready within ${readyWithinMs / 1000}s`)
  }
  const retried = reload()
  return retried.status === 0 || warnNotReloaded(stack, (retried.stderr ?? "").trim())
}

/**
 * Run `up`, a `docker compose up` in `stack`, and reload Kong after it when it moved a container
 * out from under a Kong that was already running (see `kongNeedsReload`). Returns `up`'s answer.
 */
export function upKeepingKongCurrent<T extends { status: number | null }>(
  cwd: string,
  stack: ComposeStack,
  up: () => T,
): T {
  const before = runningContainers(cwd, stack)
  const result = up()
  // A Kong the `up` started resolves afresh: nothing to look at after it.
  if (result.status !== 0 || (before !== undefined && !before.has("kong"))) return result
  if (kongNeedsReload(before, runningContainers(cwd, stack), kongUpstreams(cwd, stack))) reloadKong(cwd, stack)
  return result
}
