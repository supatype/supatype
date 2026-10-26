/**
 * Engine management commands:
 *   supatype engine status: run the host engine binary's `--version` and say what it answered
 */

import type { Command } from "commander"
import { engineVersionCheck } from "../engine-client.js"
import { error, info } from "../ui/messages.js"

export function registerEngine(program: Command): void {
  const engine = program
    .command("engine")
    .description("Manage the Supatype schema engine")

  // The engine is a binary the CLI runs, not a service. This used to print "Checking engine at
  // http://localhost:7500" and "reachable and healthy" while all it did was run `--version`.
  engine
    .command("status")
    .description("Run the host engine binary's --version and show which binary answered")
    .action(async () => {
      const check = await engineVersionCheck()
      if (check.ok) {
        info(`Engine binary: ${check.bin}`)
        info(`${check.bin} --version answered: ${check.version}`)
        return
      }
      error(
        check.bin === undefined
          ? `No engine binary could be found or downloaded: ${check.reason}`
          : `${check.bin} --version failed: ${check.reason}`,
      )
      process.exitCode = 1
    })
}
