/**
 * supatype cache — list and clean cached component binaries + REST Valkey cache.
 */

import type { Command } from "commander"
import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { cacheRoot, type Component } from "../binary-cache.js"
import {
  deleteRestCacheEntry,
  flushRestCache,
  getRestCacheEntry,
  listRestCacheEntries,
} from "../rest-cache-admin.js"
import { error, info, plain } from "../ui/messages.js"

const COMPONENTS: Component[] = ["engine", "server", "postgres", "deno"]

export function registerCache(program: Command): void {
  const cache = program
    .command("cache")
    .description("Manage cached component binaries and REST API response cache")

  cache
    .command("list")
    .description("List cached component binaries and their sizes")
    .action(async () => {
      const root = cacheRoot()
      if (!existsSync(root)) {
        info("Cache is empty.")
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
          plain(`  ${component}@${version}  ${formatBytes(size)}`)
        }
      }

      if (!found) {
        info("Cache is empty.")
        return
      }

      plain(`\nTotal: ${formatBytes(totalBytes)}`)
      info(`Cache root: ${root}`)
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
    .action(async (component?: string, version?: string) => {
      const root = cacheRoot()
      if (!existsSync(root)) {
        info("Cache is already empty.")
        return
      }

      const targets = component ? [component as Component] : COMPONENTS

      for (const comp of targets) {
        const compDir = join(root, comp)
        if (!existsSync(compDir)) continue

        if (version) {
          const vDir = join(compDir, version)
          if (!existsSync(vDir)) {
            info(`${comp}@${version} not cached.`)
            continue
          }
          rmSync(vDir, { recursive: true, force: true })
          plain(`  removed  ${comp}@${version}`)
        } else {
          rmSync(compDir, { recursive: true, force: true })
          plain(`  removed  ${comp} (all versions)`)
        }
      }

      info("Done.")
    })

  const rest = cache
    .command("rest")
    .description("Manage REST API response cache in Valkey")

  rest
    .command("list")
    .description("List cached REST GET entries")
    .option("--table <name>", "Filter by table name")
    .option("--json", "Output JSON")
    .action(async (opts: { table?: string; json?: boolean }) => {
      const cwd = process.cwd()
      try {
        const result = await listRestCacheEntries(cwd, { table: opts.table, limit: 100 })
        if (opts.json) {
          plain(JSON.stringify(result, null, 2))
          return
        }
        if (result.entries.length === 0) {
          info("No REST cache entries.")
          return
        }
        for (const e of result.entries) {
          plain(
            `  ${e.table ?? "?"}  ${e.scope ?? "?"}  ttl=${e.ttl_seconds}s  ${e.size_bytes}B  ${e.key}`,
          )
        }
        if (result.cursor !== "0") {
          plain(`\n(more available — cursor ${result.cursor})`)
        }
      } catch (e) {
        error(e instanceof Error ? e.message : String(e))
        process.exitCode = 1
      }
    })

  rest
    .command("get <key>")
    .description("Show one cache entry (full Valkey key)")
    .option("--json", "Output JSON")
    .action(async (key: string, opts: { json?: boolean }) => {
      const cwd = process.cwd()
      try {
        const detail = await getRestCacheEntry(cwd, key)
        if (opts.json) {
          plain(JSON.stringify(detail, null, 2))
          return
        }
        plain(`key:     ${detail.key}`)
        plain(`table:   ${detail.table ?? ""}`)
        plain(`scope:   ${detail.scope ?? ""}`)
        plain(`ttl:     ${detail.ttl_seconds}s`)
        plain(`status:  ${detail.status_code}`)
        if (detail.body_preview) plain(`body:\n${detail.body_preview}`)
      } catch (e) {
        error(e instanceof Error ? e.message : String(e))
        process.exitCode = 1
      }
    })

  rest
    .command("delete <key>")
    .description("Delete one cache entry")
    .action(async (key: string) => {
      const cwd = process.cwd()
      try {
        await deleteRestCacheEntry(cwd, key)
        info(`Deleted ${key}`)
      } catch (e) {
        error(e instanceof Error ? e.message : String(e))
        process.exitCode = 1
      }
    })

  rest
    .command("flush")
    .description("Flush REST cache entries")
    .option("--table <name>", "Only flush one table")
    .option("--yes", "Confirm flush")
    .action(async (opts: { table?: string; yes?: boolean }) => {
      if (!opts.yes) {
        error("Pass --yes to confirm flush")
        process.exitCode = 1
        return
      }
      const cwd = process.cwd()
      try {
        await flushRestCache(cwd, opts.table)
        info(opts.table ? `Flushed cache for table ${opts.table}` : "Flushed all REST cache entries")
      } catch (e) {
        error(e instanceof Error ? e.message : String(e))
        process.exitCode = 1
      }
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
