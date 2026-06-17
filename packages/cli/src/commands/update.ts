/**
 * supatype update — bump component versions in supatype.config.ts
 * and download the new binaries.
 */

import type { Command } from "commander"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import { loadConfig } from "../config.js"
import { resolveRuntimeProvider } from "../project-config.js"
import { runDockerCompose, writeSelfHostCompose } from "../self-host-compose.js"
import { syncComposeImagePins } from "../dev-compose.js"
import { download, currentPlatform, fetchAllLatestVersions, pinnedVersion, type Component } from "../binary-cache.js"

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
      const provider = resolveRuntimeProvider(config)

      if (provider === "docker") {
        if (opts.check) {
          console.log("Docker provider: run without --check to pull compose images (supatype self-host compose pull).")
          return
        }
        const paths = writeSelfHostCompose(cwd, config, { devLocal: true })
        syncComposeImagePins(cwd, config)
        console.log("Pulling self-host compose images...")
        const status = runDockerCompose(paths.composePath, ["pull"], cwd)
        if (status !== 0) process.exit(status)
        console.log("Compose images updated.")
        return
      }

      const platform = currentPlatform()

      const components: Component[] = ["engine", "server", "postgres", "deno"]
      const updates: Array<{ component: Component; from: string; to: string }> = []

      console.log("Fetching latest component versions from CDN...")
      const latestVersions = await fetchAllLatestVersions()

      for (const component of components) {
        const latest = latestVersions[component]
        const current = pinnedVersion(component, config)
        if (!current) {
          if (opts.check) {
            console.log(`  ${component}  (latest) → ${latest} on CDN`)
          } else {
            console.log(`\nDownloading latest ${component} v${latest}...`)
            try {
              await download(component, latest, platform)
              console.log(`  ${component} v${latest} downloaded.`)
            } catch (err) {
              console.error(`  Failed: ${(err as Error).message}`)
            }
          }
          continue
        }
        if (current === "local") continue
        if (current !== latest) {
          updates.push({ component, from: current, to: latest })
        }
      }

      if (updates.length === 0) {
        console.log(opts.check ? "All pinned components match CDN latest." : "All components are up to date.")
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
        if (text.includes(`${key}:`)) {
          text = text.replace(
            new RegExp(`(${key}\\s*:\\s*['"])[^'"]*(['"])`),
            `$1${to}$2`,
          )
        } else if (text.includes("versions:")) {
          text = text.replace(
            /(versions:\s*\{[^}]*)(\})/,
            `$1,\n    ${key}: "${to}"$2`,
          )
        } else {
          text = text.replace(
            /(\n)(\s*)(email:|schema:|storage:)/,
            `$1$2versions: {\n$2  ${key}: "${to}",\n$2},\n$2$3`,
          )
        }
      }

      writeFileSync(configPath, text, "utf8")
      console.log(`\n${basename(configPath)} updated.`)
    })
}