import { ensureBinary } from "./ensure-binary.js"
import { launchFromOverride, monorepoLaunch, type ComponentLaunchSpec } from "./component-launch.js"
import type { SupatypeProjectConfig } from "./project-config.js"

/**
 * Resolve how to spawn supatype-realtime for native dev.
 * Order: overrides.realtime → CDN binary → node + monorepo dist.
 */
export async function resolveRealtimeLaunch(
  config: SupatypeProjectConfig,
  cwd: string,
): Promise<ComponentLaunchSpec> {
  const override = config.overrides?.realtime?.trim()
  if (override) return launchFromOverride("realtime", override, cwd)

  try {
    const bin = await ensureBinary("realtime", config)
    return { bin, args: [] }
  } catch {
    const fallback = monorepoLaunch("realtime")
    if (fallback) return fallback
    throw new Error(
      "realtime binary not available, run `supatype update` or set overrides.realtime in supatype.config.ts",
    )
  }
}
