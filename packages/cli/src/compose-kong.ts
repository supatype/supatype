/**
 * Kong and the containers it sends requests to.
 *
 * Kong reaches its upstreams (server, PostgREST, Studio) by service name, and resolves a name once
 * and keeps the answer: Docker's DNS gives it a 600 s TTL, and Kong serves a stale record while it
 * refreshes. A recreated container comes back on a new address, so after the CLI recreated the
 * server, sign-in through Kong answered 502 until Kong was restarted by hand (EXT-N1).
 *
 * Shortening Kong's DNS TTLs instead broke Studio from its dev server: `host.docker.internal` is a
 * hosts-file entry (`extra_hosts`), and with a 5 s TTL Kong dropped it and asked Docker's DNS,
 * which does not know it (CE1). So the TTLs are Kong's defaults, and every `docker compose up` the
 * CLI runs is followed by a reload (`runDockerCompose`): `kong reload` starts fresh workers with
 * empty DNS caches, without dropping the connections in flight.
 */
import { spawnSync } from "node:child_process"
import { composeBaseArgs, type ComposeStack } from "./compose-db-psql.js"

/** True when the named compose service has a running container. */
export function composeServiceIsRunning(cwd: string, stack: ComposeStack, service: string): boolean {
  const result = spawnSync("docker", [...composeBaseArgs(cwd, stack), "ps", "-q", "--status", "running", service], {
    cwd,
    encoding: "utf8",
  })
  return result.status === 0 && typeof result.stdout === "string" && result.stdout.trim() !== ""
}

/**
 * Have a running Kong resolve its upstreams again: `kong reload`, or a restart when the reload
 * could not run (Kong still starting). Nothing when Kong is not running: it resolves afresh when
 * it starts. True when Kong is now current.
 */
export function reloadKong(cwd: string, stack: ComposeStack): boolean {
  if (!composeServiceIsRunning(cwd, stack, "kong")) return true
  const run = (args: string[]) => spawnSync("docker", [...composeBaseArgs(cwd, stack), ...args], { cwd, encoding: "utf8" })
  if (run(["exec", "-T", "kong", "kong", "reload"]).status === 0) return true
  const restart = run(["restart", "kong"])
  if (restart.status === 0) return true
  console.warn(
    "[supatype] Kong could not be reloaded after a container behind it was recreated; requests may fail " +
      `until it is restarted (supatype self-host compose restart kong): ${(restart.stderr ?? "").trim()}`,
  )
  return false
}
