import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { ProcessManager } from "./process-manager.js"

const STUDIO_PORT = 3002

export interface StudioDevServerOptions {
  cwd: string
  studioOverride: string
  pidDir: string
  serviceRoleKey: string
  /**
   * Where Vite proxies API requests (Kong gateway port for compose dev, or
   * supatype-server port for native `supatype dev`).
   */
  proxyTarget: string
  /**
   * Public Supatype URL the browser uses. Compose dev: Kong on the host.
   * Native dev: Vite dev server (same origin as Studio).
   */
  viteSupatypeUrl: string
  /** Vite `base` — `/studio/` when behind Kong at `/studio/`; `/` for native dev on :3002. */
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
    [viteJs, "--port", String(STUDIO_PORT), "--strictPort", "--host"],
    {
      label: "studio",
      pidDir: opts.pidDir,
      cwd: studioDir,
      colour: "\x1b[35m",
      env: {
        VITE_SUPATYPE_URL: opts.viteSupatypeUrl,
        SUPATYPE_PROXY_TARGET: opts.proxyTarget,
        VITE_SUPATYPE_ANON_KEY: opts.serviceRoleKey,
        VITE_SUPATYPE_SERVICE_ROLE_KEY: opts.serviceRoleKey,
        VITE_BASE_PATH: basePath,
      },
    },
  )
}
