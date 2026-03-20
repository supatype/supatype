/**
 * supatype logs — tail aggregated logs from local Docker containers.
 */
import type { Command } from "commander"
import { spawn } from "node:child_process"

const SERVICES = ["postgres", "postgrest", "gotrue", "kong", "minio", "realtime", "studio"]

export function registerLogs(program: Command): void {
  program
    .command("logs")
    .description("Tail aggregated logs from local dev services")
    .option("--service <name>", "Filter to a specific service")
    .option("--since <duration>", "Show logs since duration (e.g., 5m, 1h)", "5m")
    .option("-f, --follow", "Follow log output", true)
    .action((opts: { service?: string; since?: string; follow?: boolean }) => {
      const services = opts.service
        ? [`supatype-${opts.service}`]
        : SERVICES.map((s) => `supatype-${s}`)

      if (opts.service && !SERVICES.includes(opts.service)) {
        console.error(`Unknown service: ${opts.service}`)
        console.error(`Available: ${SERVICES.join(", ")}`)
        process.exit(1)
      }

      const args = ["compose", "logs"]
      if (opts.follow) args.push("-f")
      if (opts.since) args.push("--since", opts.since)
      args.push("--tail", "100")

      // If filtering by service, use docker logs for that container
      if (opts.service) {
        const containerArgs = ["logs"]
        if (opts.follow) containerArgs.push("-f")
        if (opts.since) containerArgs.push("--since", opts.since)
        containerArgs.push("--tail", "100")
        containerArgs.push(`supatype-${opts.service}`)

        const child = spawn("docker", containerArgs, { stdio: "inherit" })
        child.on("error", () => {
          console.error("Docker not found. Ensure Docker is installed and running.")
          process.exit(1)
        })
        return
      }

      // Aggregated logs via docker compose
      const child = spawn("docker", args, {
        stdio: "inherit",
        cwd: process.cwd(),
      })
      child.on("error", () => {
        console.error("Docker not found. Ensure Docker is installed and running.")
        process.exit(1)
      })
    })
}
