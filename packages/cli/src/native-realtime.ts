import { ProcessManager } from "./process-manager.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import { resolveRealtimeLaunch, type RealtimeLaunchSpec } from "./realtime-launch.js"
import { patchRouteManifest } from "./route-manifest.js"

export interface NativeRealtimeOptions {
  config: SupatypeProjectConfig
  cwd: string
  manifestPath: string
  pidDir: string
  /** Where realtime listens, as the gateway reaches it. */
  url: string
  port: string
  databaseUrl: string
  jwtSecret: string
}

type ResolveLaunch = (config: SupatypeProjectConfig, cwd: string) => Promise<RealtimeLaunchSpec>

function spawnRealtime(launch: RealtimeLaunchSpec, opts: NativeRealtimeOptions): ProcessManager {
  const proc = new ProcessManager(launch.bin, launch.args, {
    label: "realtime",
    pidDir: opts.pidDir,
    colour: "\x1b[35m",
    env: {
      DATABASE_URL: opts.databaseUrl,
      JWT_SECRET: opts.jwtSecret,
      PORT: opts.port,
      SLOT_NAME: "supatype_realtime",
      PUBLICATION_NAME: "supatype_realtime",
    },
  })
  proc.start()
  return proc
}

/**
 * Start realtime for native dev, and record in the route manifest whether it is running.
 *
 * The manifest is what the gateway routes /realtime/v1 by. Enabled with nothing listening, it
 * proxies every subscription to a dead port and answers a bare 502, and its /health reports the
 * whole stack not ready. Disabled, it answers "realtime disabled" and health leaves realtime out.
 * `realtime_url` is dropped too, so a URL from an earlier run is not left pointing at nothing.
 */
export async function startNativeRealtime(
  opts: NativeRealtimeOptions,
  resolveLaunch: ResolveLaunch = resolveRealtimeLaunch,
): Promise<ProcessManager | null> {
  try {
    const proc = spawnRealtime(await resolveLaunch(opts.config, opts.cwd), opts)
    patchRouteManifest(opts.manifestPath, { realtime_enabled: true, realtime_url: opts.url })
    console.log(`[supatype] Realtime service: ${opts.url}`)
    return proc
  } catch (err) {
    patchRouteManifest(opts.manifestPath, { realtime_enabled: false, realtime_url: undefined })
    console.warn(
      "[supatype] ⚠  Realtime unavailable, so the gateway will answer realtime requests with " +
        `"realtime disabled" and WebSocket subscriptions will not work.\n  ${(err as Error).message}`,
    )
    return null
  }
}
