/**
 * supatype self-update — Phase 10.6C8.
 *
 * npm-installed CLI: instruct to use `npm update -g`.
 * Standalone / future curl|sh installs: CDN-published CLI binary replacement is not wired yet.
 */

import type { Command } from "commander"
import { sep } from "node:path"
import { error, plain } from "../ui/messages.js"

function looksLikeNpmOrWorkspaceCLI(): boolean {
  const main = process.argv[1] ?? ""
  return (
    main.includes("node_modules") ||
    main.includes(`${sep}dist${sep}cli`) ||
    main.includes(`${sep}bin${sep}supatype.js`) ||
    Boolean(process.env["npm_execpath"]) ||
    Boolean(process.env["npm_lifecycle_event"])
  )
}

export function registerSelfUpdate(program: Command): void {
  program
    .command("self-update")
    .description(
      "Update the supatype CLI (npm: use npm update; standalone binary swap from CDN is not available yet)",
    )
    .action(() => {
      if (looksLikeNpmOrWorkspaceCLI()) {
        plain(
          "This CLI was installed via npm (or runs from the package workspace).\n" +
            "Update with:\n\n  npm update -g @supatype/cli\n\n" +
            "To bump engine/server/postgres/deno pinned in supatype.config.ts, use:\n\n  supatype update\n",
        )
        return
      }

      error(
        "Standalone CLI self-update (replace binary from CDN) is not published yet.\n\n" +
          "Install or upgrade via npm:\n  npm install -g @supatype/cli\n\n" +
          "Component binaries (engine, server, postgres, deno):\n  supatype update\n",
      )
      process.exit(1)
    })
}
