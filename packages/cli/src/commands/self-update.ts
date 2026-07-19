/**
 * supatype self-update — Phase 10.6C8.
 *
 * npm-installed CLI: instruct to use `npm update -g`.
 * Standalone curl|sh installs: replace binary from releases.supatype.com/cli/.
 */

import type { Command } from "commander"
import { copyFileSync, renameSync } from "node:fs"
import { sep } from "node:path"
import { downloadStandaloneCli, fetchStandaloneCliLatestVersion } from "../cli-standalone.js"
import { error, info, plain } from "../ui/messages.js"

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
    .description("Update the supatype CLI (npm or standalone CDN binary)")
    .action(async () => {
      if (looksLikeNpmOrWorkspaceCLI()) {
        plain(
          "This CLI was installed via npm (or runs from the package workspace).\n" +
            "Update with:\n\n  npm update -g @supatype/cli\n\n" +
            "To bump engine/server/postgres/deno/realtime pinned in supatype.config.ts, use:\n\n  supatype update\n",
        )
        return
      }

      const currentPath = process.argv[1]
      if (!currentPath) {
        error("Could not determine current CLI path.")
        process.exit(1)
      }

      try {
        const latest = await fetchStandaloneCliLatestVersion()
        info(`Downloading supatype CLI v${latest}...`)
        const downloaded = await downloadStandaloneCli(latest)
        const backup = `${currentPath}.bak`
        copyFileSync(currentPath, backup)
        try {
          renameSync(downloaded, currentPath)
        } catch (err) {
          copyFileSync(downloaded, currentPath)
        }
        info(`Updated to v${latest}.`)
        plain("Run `supatype --version` to verify.")
      } catch (err) {
        error(
          `Standalone CLI self-update failed: ${(err as Error).message}\n\n` +
            "Install or upgrade via npm:\n  npm install -g @supatype/cli\n\n" +
            "Component binaries (engine, server, postgres, deno, realtime):\n  supatype update\n",
        )
        process.exit(1)
      }
    })
}
