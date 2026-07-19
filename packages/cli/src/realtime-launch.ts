import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ensureBinary } from "./ensure-binary.js"
import type { SupatypeProjectConfig } from "./project-config.js"

export interface RealtimeLaunchSpec {
  bin: string
  args: string[]
}

const CLI_PKG_DIR = dirname(fileURLToPath(import.meta.url))

/** Monorepo contributor fallback: packages/realtime/dist/index.js relative to CLI package. */
function monorepoRealtimeEntry(): string | null {
  const candidate = resolve(CLI_PKG_DIR, "../../realtime/dist/index.js")
  return existsSync(candidate) ? candidate : null
}

/**
 * Resolve how to spawn supatype-realtime for native dev.
 * Order: overrides.realtime → CDN binary → node + monorepo dist.
 */
export async function resolveRealtimeLaunch(
  config: SupatypeProjectConfig,
  cwd: string,
): Promise<RealtimeLaunchSpec> {
  const override = config.overrides?.realtime?.trim()
  if (override) {
    const resolved = resolve(cwd, override)
    if (!existsSync(resolved)) {
      throw new Error(`[overrides] realtime path does not exist: ${resolved}`)
    }
    if (resolved.endsWith(".js") || resolved.endsWith(".mjs") || resolved.endsWith(".cjs")) {
      return { bin: process.execPath, args: [resolved] }
    }
    return { bin: resolved, args: [] }
  }

  try {
    const bin = await ensureBinary("realtime", config)
    return { bin, args: [] }
  } catch {
    const entry = monorepoRealtimeEntry()
    if (entry) {
      return { bin: process.execPath, args: [entry] }
    }
    throw new Error(
      "realtime binary not available — run `supatype update` or set overrides.realtime in supatype.config.ts",
    )
  }
}
