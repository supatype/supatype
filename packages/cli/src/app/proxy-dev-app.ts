/**
 * Spawn the frontend dev server during `supatype dev` when app.mode is proxy.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { detectPackageManager } from "./framework.js"
import { appendDevTaskLog } from "../dev-session.js"
import { ProcessManager } from "../process-manager.js"
import { projectRootFromConfig, type SupatypeProjectConfig } from "../project-config.js"

const DEFAULT_PROXY_DEV_SCRIPT = "start"

/** package.json script name to run (only when app.mode is proxy). */
export function resolveProxyDevScript(config: SupatypeProjectConfig): string | null {
  if (config.app?.mode !== "proxy") return null
  const script = config.app.start?.trim()
  return script && script.length > 0 ? script : DEFAULT_PROXY_DEV_SCRIPT
}

/**
 * Start the configured package.json script for proxy dev.
 * Returns null when not in proxy mode or when the script is missing.
 */
export function startProxyDevApp(
  cwd: string,
  config: SupatypeProjectConfig,
  pidDir: string,
): ProcessManager | null {
  const script = resolveProxyDevScript(config)
  if (!script) return null

  const appDir = projectRootFromConfig(config, cwd)
  const pkgPath = join(appDir, "package.json")
  if (!existsSync(pkgPath)) {
    console.warn(`[supatype] app.mode=proxy but no package.json at ${appDir}; skipping dev app`)
    return null
  }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    scripts?: Record<string, string>
  }
  if (!pkg.scripts?.[script]) {
    console.warn(
      `[supatype] app.mode=proxy: package.json has no "${script}" script.\n` +
        `  Add "scripts.${script}" or set app.start in supatype.config.ts`,
    )
    return null
  }

  const pm = detectPackageManager(appDir)
  const bin = pm
  const args = pm === "yarn" ? [script] : ["run", script]
  // pnpm/npm/yarn are .cmd shims on Windows — spawn via shell so PATH resolution works.
  const useShell = process.platform === "win32"

  appendDevTaskLog("app", "app", `Proxy mode: running ${bin} ${args.join(" ")} (${appDir})`)

  const manager = new ProcessManager(bin, args, {
    label: "app",
    pidDir,
    cwd: appDir,
    colour: "\x1b[33m",
    shell: useShell,
  })
  manager.start()
  return manager
}
