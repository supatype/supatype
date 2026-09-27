import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { ProcessManager } from "./process-manager.js"

/**
 * Vite dev server port when `overrides.studio` is set.
 *
 * Overridable because it is bound with `--strictPort`, so anything else already on 3002 does not
 * make Vite pick another port, it makes Studio fail to start and be restarted every thirty seconds
 * for the life of the session. 3002 is an ordinary port for a local app to be sitting on, and the
 * only signal is a Vite stack trace in among the compose output.
 *
 * Only the `overrides.studio` path is affected, so this is a contributor's papercut rather than a
 * user's: an ordinary `supatype dev` serves Studio from its container.
 */
export const STUDIO_DEV_PORT = Number(process.env["SUPATYPE_STUDIO_DEV_PORT"]) || 3002

export interface StudioDevServerOptions {
  cwd: string
  studioOverride: string
  pidDir: string
  /**
   * The anon key, and only the anon key. Studio in the browser is an untrusted
   * client: privileged calls go through /studio/proxy, which holds the service
   * role key server-side and applies membership, role permissions and the audit
   * trail. Studio refuses a service role key handed to the browser and says so
   * loudly, which is what this used to trigger on every dev start.
   */
  anonKey: string
  /**
   * Where Vite proxies API requests (Kong gateway port for compose dev, or
   * supatype-server port for native `supatype dev`).
   */
  proxyTarget: string
  /**
   * Browser API base URL. Must match the Vite dev origin (`http://localhost:3002`)
   * so fetches hit the Vite proxy (SUPATYPE_PROXY_TARGET) and avoid CORS.
   */
  viteSupatypeUrl: string
  /** Vite `base`: `/studio/` when behind Kong at `/studio/`; `/` for native dev on :3002. */
  basePath?: string
}

/** Start @supatype/studio Vite dev server when `overrides.studio` is set. */
export function startStudioViteDevServer(opts: StudioDevServerOptions): ProcessManager | null {
  const studioDir = resolve(opts.cwd, opts.studioOverride)
  const viteJs = join(studioDir, "node_modules", "vite", "bin", "vite.js")
  if (!existsSync(viteJs)) {
    console.warn(`[supatype] ⚠  Studio override set but vite not found at ${viteJs}. Run: pnpm install`)
    return null
  }

  const basePath = opts.basePath ?? "/"
  return new ProcessManager(
    process.execPath,
    [viteJs, "--port", String(STUDIO_DEV_PORT), "--strictPort", "--host"],
    {
      label: "studio",
      pidDir: opts.pidDir,
      cwd: studioDir,
      colour: "\x1b[35m",
      env: {
        VITE_SUPATYPE_URL: opts.viteSupatypeUrl,
        SUPATYPE_PROXY_TARGET: opts.proxyTarget,
        VITE_SUPATYPE_ANON_KEY: opts.anonKey,
        VITE_BASE_PATH: basePath,
      },
    },
  )
}
