/**
 * supatype logs: tail logs from the local stack.
 */
import type { Command } from "commander"
import { spawn } from "node:child_process"
import { composeArgs, composeContext, composeServiceNames } from "../compose-services.js"
import { error, info } from "../ui/messages.js"

/**
 * logsArgs builds the compose invocation.
 *
 * Compose is asked for the logs rather than `docker logs <name>`, because the
 * container names are Compose's to choose: the generated file sets no
 * `container_name`, so a container is `<project>-<service>-<n>` and guessing at
 * that name is what left this command tailing containers that never existed.
 */
export function logsArgs(
  base: string[],
  opts: { service?: string; since?: string; follow?: boolean },
): string[] {
  const args = [...base, "logs", "--tail", "100"]
  if (opts.follow) args.push("--follow")
  if (opts.since) args.push("--since", opts.since)
  if (opts.service) args.push(opts.service)
  return args
}

export function registerLogs(program: Command): void {
  program
    .command("logs")
    .description("Tail logs from the local stack")
    .option("--service <name>", "Filter to a single service")
    .option("--since <duration>", "Show logs since duration (e.g. 5m, 1h)", "5m")
    .option("-f, --follow", "Follow log output", true)
    .action((opts: { service?: string; since?: string; follow?: boolean }) => {
      const ctx = composeContext(process.cwd())
      if (!ctx) {
        error("No generated compose file here.")
        info("Run `supatype self-host compose up` to create the stack.")
        process.exit(1)
      }

      const available = composeServiceNames(ctx)
      if (opts.service && available.length > 0 && !available.includes(opts.service)) {
        error(`Unknown service: ${opts.service}`)
        error(`Available: ${available.join(", ")}`)
        process.exit(1)
      }

      const child = spawn("docker", logsArgs(composeArgs(ctx), opts), { stdio: "inherit" })
      child.on("error", () => {
        error("Docker not found. Ensure Docker is installed and running.")
        process.exit(1)
      })
    })
}
