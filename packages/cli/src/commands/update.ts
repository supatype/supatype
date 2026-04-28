/**
 * supatype update — bump component versions in supatype.config.toml
 * and download the new binaries.
 */

import type { Command } from "commander"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { loadTomlConfig } from "../config-toml.js"
import { download, currentPlatform, type Component } from "../binary-cache.js"

// Canonical latest versions — bumped on each release.
const LATEST_VERSIONS: Record<Component, string> = {
  engine: "0.4.2",
  server: "0.1.0",
  postgres: "17.2",
  deno: "2.2.0",
}

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description(
      "Download the latest component binaries and update [versions] in supatype.config.toml",
    )
    .option("--check", "Print available updates without downloading", false)
    .action(async (opts: { check: boolean }) => {
      const cwd = process.cwd()
      const config = loadTomlConfig(cwd)
      const platform = currentPlatform()

      const components: Component[] = ["engine", "server", "postgres", "deno"]
      const updates: Array<{ component: Component; from: string; to: string }> = []

      for (const component of components) {
        const current = config.versions[component]
        const latest = LATEST_VERSIONS[component]
        if (current !== latest) {
          updates.push({ component, from: current, to: latest })
        }
      }

      if (updates.length === 0) {
        console.log("All components are up to date.")
        return
      }

      console.log("Available updates:")
      for (const { component, from, to } of updates) {
        console.log(`  ${component}  ${from} → ${to}`)
      }

      if (opts.check) return

      // Download updated binaries.
      for (const { component, to } of updates) {
        console.log(`\nDownloading ${component} v${to}...`)
        try {
          await download(component, to, platform)
        } catch (err) {
          console.error(`  Failed: ${(err as Error).message}`)
          continue
        }
        console.log(`  ${component} v${to} downloaded.`)
      }

      // Patch [versions] in supatype.config.toml.
      const tomlPath = resolve(cwd, "supatype.config.toml")
      let toml = readFileSync(tomlPath, "utf8")

      for (const { component, to } of updates) {
        // Replace: engine   = "0.4.1" → engine   = "0.4.2"
        const key = component === "postgres" ? "postgres" : component
        toml = toml.replace(
          new RegExp(`(${key}\\s*=\\s*)"[^"]*"`),
          `$1"${to}"`,
        )
      }

      writeFileSync(tomlPath, toml, "utf8")
      console.log("\nsupatype.config.toml updated.")
    })
}
