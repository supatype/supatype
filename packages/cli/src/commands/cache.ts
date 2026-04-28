/**
 * supatype cache — list and clean cached component binaries.
 */

import type { Command } from "commander"
import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { cacheRoot, type Component } from "../binary-cache.js"

const COMPONENTS: Component[] = ["engine", "server", "postgres", "deno"]

export function registerCache(program: Command): void {
  const cache = program
    .command("cache")
    .description("Manage cached component binaries")

  cache
    .command("list")
    .description("List cached component binaries and their sizes")
    .action(() => {
      const root = cacheRoot()
      if (!existsSync(root)) {
        console.log("Cache is empty.")
        return
      }

      let totalBytes = 0
      let found = false

      for (const component of COMPONENTS) {
        const compDir = join(root, component)
        if (!existsSync(compDir)) continue

        const versions = readdirSync(compDir).filter(
          (v) => statSync(join(compDir, v)).isDirectory(),
        )
        for (const version of versions) {
          const vDir = join(compDir, version)
          const size = dirSize(vDir)
          totalBytes += size
          found = true
          console.log(`  ${component}@${version}  ${formatBytes(size)}`)
        }
      }

      if (!found) {
        console.log("Cache is empty.")
        return
      }

      console.log(`\nTotal: ${formatBytes(totalBytes)}`)
      console.log(`Cache root: ${root}`)
    })

  cache
    .command("clean [component] [version]")
    .description(
      "Remove cached binaries. Optionally specify a component and/or version.\n" +
        "Examples:\n" +
        "  supatype cache clean           # remove everything\n" +
        "  supatype cache clean engine    # remove all engine versions\n" +
        "  supatype cache clean engine 0.4.2",
    )
    .action((component?: string, version?: string) => {
      const root = cacheRoot()
      if (!existsSync(root)) {
        console.log("Cache is already empty.")
        return
      }

      const targets = component ? [component as Component] : COMPONENTS

      for (const comp of targets) {
        const compDir = join(root, comp)
        if (!existsSync(compDir)) continue

        if (version) {
          const vDir = join(compDir, version)
          if (!existsSync(vDir)) {
            console.log(`  ${comp}@${version} not cached.`)
            continue
          }
          rmSync(vDir, { recursive: true, force: true })
          console.log(`  removed  ${comp}@${version}`)
        } else {
          rmSync(compDir, { recursive: true, force: true })
          console.log(`  removed  ${comp} (all versions)`)
        }
      }

      console.log("Done.")
    })
}

function dirSize(dir: string): number {
  let total = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        total += dirSize(full)
      } else {
        total += statSync(full).size
      }
    }
  } catch {
    // Skip unreadable entries.
  }
  return total
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
