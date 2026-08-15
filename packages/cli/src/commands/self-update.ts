/**

 * supatype self-update — Phase 10.6C8.

 *

 * npm-installed CLI: instruct to use `npm update -g`.

 * Homebrew: instruct to use `brew upgrade supatype`.

 * Standalone curl|sh installs: replace binary from releases.supatype.com/cli/.

 */



import type { Command } from "commander"

import { copyFileSync, renameSync } from "node:fs"

import { detectCliInstallMethod } from "../cli-install-method.js"

import { downloadStandaloneCli, fetchStandaloneCliLatestVersion } from "../cli-standalone.js"

import { error, info, plain } from "../ui/messages.js"



export function registerSelfUpdate(program: Command): void {

  program

    .command("self-update")

    .description("Update the supatype CLI (npm or standalone CDN binary)")

    .action(async () => {

      const method = detectCliInstallMethod()



      if (method === "npm") {

        plain(

          "This CLI was installed via npm (or runs from the package workspace).\n" +

            "Update with:\n\n  npm update -g @supatype/cli\n\n" +

            "To bump engine/server/postgres/deno/realtime pinned in supatype.config.ts, use:\n\n  supatype update\n",

        )

        return

      }



      if (method === "homebrew") {

        plain(

          "This CLI was installed via Homebrew.\n" +

            "Update with:\n\n  brew update && brew upgrade supatype\n\n" +

            "To bump component binaries pinned in supatype.config.ts, use:\n\n  supatype update\n",

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

        } catch {

          copyFileSync(downloaded, currentPath)

        }

        info(`Updated to v${latest}.`)

        plain("Run `supatype --version` to verify.")

      } catch (err) {

        error(

          `Standalone CLI self-update failed: ${(err as Error).message}\n\n` +

            "Install or upgrade via npm:\n  npm install -g @supatype/cli\n\n" +

            "Or Homebrew:\n  brew upgrade supatype\n\n" +

            "Component binaries (engine, server, postgres, deno, realtime):\n  supatype update\n",

        )

        process.exit(1)

      }

    })

}


