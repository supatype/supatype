/**
 * supatype cache: list and clean cached component binaries + REST Valkey cache.
 */

import type { Command } from "commander"
import { existsSync } from "node:fs"
import {
  BINARY_COMPONENTS,
  formatBytes,
  listCacheEntries,
  resolveCacheProjectDirs,
} from "../cache-clean.js"
import { cleanCachedBinaries } from "../cache-pins.js"
import { cacheRoot, type Component } from "../binary-cache.js"
import {
  deleteRestCacheEntry,
  flushRestCache,
  getRestCacheEntry,
  listRestCacheEntries,
} from "../rest-cache-admin.js"
import { error, info, plain, warn } from "../ui/messages.js"

function isComponent(value: string): value is Component {
  return (BINARY_COMPONENTS as readonly string[]).includes(value)
}

export function registerCache(program: Command): void {
  const cache = program
    .command("cache")
    .description("Manage cached component binaries and REST API response cache")

  cache
    .command("list")
    .description("List cached component binaries and their sizes")
    .option("--project <path>", "Include pins from another project directory", collectPaths, [])
    .action(async (opts: { project: string[] }) => {
      const cwd = process.cwd()
      const projectDirs = resolveCacheProjectDirs(cwd, opts.project)
      const root = cacheRoot()

      if (!existsSync(root)) {
        info("Cache is empty.")
        return
      }

      const entries = listCacheEntries(projectDirs)
      if (entries.length === 0) {
        info("Cache is empty.")
        return
      }

      let totalBytes = 0
      for (const entry of entries) {
        totalBytes += entry.bytes
        const pinLabel = entry.pinned ? "  (pinned)" : ""
        plain(`  ${entry.component}@${entry.version}  ${formatBytes(entry.bytes)}${pinLabel}`)
      }

      plain(`\nTotal: ${formatBytes(totalBytes)}`)
      info(`Cache root: ${root}`)
      if (projectDirs.length > 0) {
        info(`Pin scan: ${projectDirs.length} project(s)`)
      }
    })

  cache
    .command("clean [component] [version]")
    .description(
      "Remove cached binaries not pinned by local project configs.\n" +
        "Use --force to remove everything (legacy behavior).\n" +
        "Examples:\n" +
        "  supatype cache clean                    # remove unpinned versions\n" +
        "  supatype cache clean engine             # remove unpinned engine versions\n" +
        "  supatype cache clean engine 0.4.2       # remove one version (warns if pinned)\n" +
        "  supatype cache clean --force            # remove all cached binaries",
    )
    .option("--dry-run", "Show what would be removed without deleting")
    .option("--force", "Remove all matching cache entries, ignoring version pins")
    .option("--project <path>", "Include pins from another project directory", collectPaths, [])
    .action(
      async (
        component?: string,
        version?: string,
        opts?: { dryRun?: boolean; force?: boolean; project?: string[] },
      ) => {
        const cwd = process.cwd()
        const projectDirs = resolveCacheProjectDirs(cwd, opts?.project ?? [])
        const root = cacheRoot()

        if (!existsSync(root)) {
          info("Cache is already empty.")
          return
        }

        if (component && !isComponent(component)) {
          error(
            `Unknown component "${component}". Valid: ${BINARY_COMPONENTS.join(", ")}`,
          )
          process.exitCode = 1
          return
        }

        const components: Component[] =
          component !== undefined ? [component as Component] : [...BINARY_COMPONENTS]
        const result = cleanCachedBinaries({
          components,
          ...(version !== undefined && version !== "" ? { version } : {}),
          ...(opts?.force !== undefined ? { force: opts.force } : {}),
          ...(opts?.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
          projectDirs,
        })

        for (const message of result.warned) {
          warn(message)
        }

        for (const entry of result.skipped) {
          plain(`  kept     ${entry.component}@${entry.version}  (${entry.reason})`)
        }

        for (const entry of result.removed) {
          const prefix = opts?.dryRun ? "would remove" : "removed"
          plain(`  ${prefix}  ${entry.component}@${entry.version}`)
        }

        if (result.removed.length === 0 && result.skipped.length === 0) {
          info("Nothing to clean.")
        } else if (opts?.dryRun) {
          info(`Dry run: ${result.removed.length} entr${result.removed.length === 1 ? "y" : "ies"} would be removed.`)
        } else {
          info("Done.")
        }
      },
    )

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
          plain(`\n(more available: cursor ${result.cursor})`)
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

function collectPaths(value: string, previous: string[]): string[] {
  return [...previous, value]
}
