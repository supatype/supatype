/**
 * Engine management commands:
 *   supatype engine status  — check if the engine container is reachable
 */

import type { Command } from "commander"
import { engineHealth } from "../engine-client.js"
import { error, info } from "../ui/messages.js"

export function registerEngine(program: Command): void {
  const engine = program
    .command("engine")
    .description("Manage the Supatype schema engine")

  engine
    .command("status")
    .description("Check if the schema engine container is reachable")
    .action(async () => {
      const url = process.env["SUPATYPE_ENGINE_URL"] ?? "http://localhost:7500"
      info(`Checking engine at ${url}...`)

      const healthy = await engineHealth()
      if (healthy) {
        info("Engine is reachable and healthy.")
      } else {
        error("Engine is not reachable.")
        error("Make sure the engine container is running (supatype dev or docker compose up).")
        process.exitCode = 1
      }
    })
}
