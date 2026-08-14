/**
 * Hidden internal commands (Homebrew post_install, etc.).
 */

import type { Command } from "commander"
import { downloadAll } from "../binary-cache.js"
import { error, info } from "../ui/messages.js"

export function registerInternalCommands(program: Command): void {
  program
    .command("_postinstall", { hidden: true })
    .description("Prefetch CDN component binaries after install (Homebrew post_install)")
    .action(async () => {
      try {
        info("Prefetching Supatype component binaries for this platform...")
        await downloadAll(undefined, true)
        info("Component prefetch complete.")
      } catch (err) {
        error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })
}
