/**
 * Sizes on disk, and how the CLI prints them. Shared by `cache list`, `cache clean` and the npm
 * starter's notice about old CLI versions, which loads it before every command, so it imports
 * nothing but Node's own modules.
 */

import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/** The bytes under `dir`, skipping anything that cannot be read. */
export function dirSize(dir: string): number {
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
    // skip unreadable
  }
  return total
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
