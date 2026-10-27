/**
 * Docker running out of network address pools, recognised and explained.
 *
 * Every compose project gets its own network, carved from a fixed set of pools. With enough stacks
 * left behind, `compose up` fails with "all predefined address pools have been fully subnetted",
 * which names neither the cause nor the fix.
 */

import { spawnSync } from "node:child_process"

/** One docker invocation's outcome. Injected so the decisions here are testable without Docker. */
export type DockerRun = (args: readonly string[]) => { status: number | null; stdout: string; stderr: string }

const dockerRun: DockerRun = (args) => {
  const result = spawnSync("docker", [...args], { encoding: "utf8" })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

/** Whether docker or compose output says the address pools are exhausted. */
export function isAddressPoolExhausted(output: string): boolean {
  return /all predefined address pools have been fully subnetted/i.test(output)
}

/** How many networks Docker has for Supatype compose projects, or null when it cannot say. */
function supatypeNetworkCount(run: DockerRun): number | null {
  const result = run(["network", "ls", "--filter", "name=supatype-", "-q"])
  if (result.status !== 0) return null
  return result.stdout.split("\n").filter((line) => line.trim() !== "").length
}

/**
 * Whether Docker cannot create a network now. For a failed `up` whose output went to the terminal
 * rather than through the CLI. The probe network is removed again when it was created.
 */
function poolExhaustedNow(run: DockerRun): boolean {
  const name = `supatype-address-pool-probe-${process.pid}`
  const created = run(["network", "create", name])
  if (created.status === 0) {
    run(["network", "rm", name])
    return false
  }
  return isAddressPoolExhausted(`${created.stderr}\n${created.stdout}`)
}

function networkCountLine(count: number | null): string[] {
  if (count === null) return []
  return [`There ${count === 1 ? "is 1 Supatype network" : `are ${count} Supatype networks`} on this machine.`]
}

/**
 * The lines to print after a failed `compose up` when the cause was exhausted address pools, or none.
 *
 * `output` is what compose printed, when the CLI captured it. Null means it went to the terminal,
 * and Docker is asked directly instead.
 */
export function addressPoolExhaustionHint(output: string | null, run: DockerRun = dockerRun): string[] {
  const exhausted = output === null ? poolExhaustedNow(run) : isAddressPoolExhausted(output)
  if (!exhausted) return []
  return [
    "Docker has no network addresses left for a new compose project: every predefined address pool is in use.",
    ...networkCountLine(supatypeNetworkCount(run)),
    "`docker network prune` removes the networks no container is using, including those of stopped stacks.",
  ]
}
