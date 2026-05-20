/**
 * supatype update — bump component versions in supatype.config.ts
 * and download the new binaries.
 */

import type { Command } from "commander"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import { loadConfig } from "../config.js"
import { download, currentPlatform, type Component } from "../binary-cache.js"
import { DENO_RELEASE_PIN } from "../release-pins.js"

// Canonical latest versions — bumped on each release.
const LATEST_VERSIONS: Record<Component, string> = {
  engine: "0.4.2",
  server: "0.1.0",
  postgres: "17.2",
  deno: DENO_RELEASE_PIN,
}

const CONFIG_CANDIDATES = ["supatype.config.ts", "supatype.config.js", "supatype.config.mjs"]

function resolveConfigFile(cwd: string): string | null {
  for (const name of CONFIG_CANDIDATES) {
    const p = resolve(cwd, name)
    if (existsSync(p)) return p
  }
  return null
}

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description(
      "Download the latest component binaries and update versions in supatype.config.ts",
    )
    .option("--check", "Print available updates without downloading", false)
    .action(async (opts: { check: boolean }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const platform = currentPlatform()

      const components: Component[] = ["engine", "server", "postgres", "deno"]
      const updates: Array<{ component: Component; from: string; to: string }> = []

      for (const component of components) {
        const current = config.versions[component]
        if (current === "local") continue
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

      const configPath = resolveConfigFile(cwd)
      if (configPath === null) {
        console.error("No supatype.config.ts (or .js/.mjs) found to patch versions.")
        process.exit(1)
      }

      let text = readFileSync(configPath, "utf8")
      for (const { component, to } of updates) {
        const key = component
        // engine: "0.4.1"  or  engine: '0.4.1'
        text = text.replace(
          new RegExp(`(${key}\\s*:\\s*['"])[^'"]*(['"])`),
          `$1${to}$2`,
        )
      }

      writeFileSync(configPath, text, "utf8")
      console.log(`\n${basename(configPath)} updated.`)
    })
}