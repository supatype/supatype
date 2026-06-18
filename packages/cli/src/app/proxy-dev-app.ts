/**
 * Spawn the frontend dev server during `supatype dev` when app.mode is proxy.
 */

import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { detectPackageManager } from "./framework.js"
import { appendDevTaskLog } from "../dev-session.js"
import { ProcessManager, readPid } from "../process-manager.js"
import { projectRootFromConfig, type SupatypeProjectConfig } from "../project-config.js"

const DEFAULT_PROXY_DEV_SCRIPT = "start"

/** package.json script name to run (only when app.mode is proxy). */
export function resolveProxyDevScript(config: SupatypeProjectConfig): string | null {
  if (config.app?.mode !== "proxy") return null
  const script = config.app.start?.trim()
  return script && script.length > 0 ? script : DEFAULT_PROXY_DEV_SCRIPT
}

/** Port from app.upstream (e.g. http://localhost:5285 → 5285). */
export function portFromUpstream(config: SupatypeProjectConfig): number | null {
  const raw = config.app?.upstream?.trim()
  if (!raw) return null
  try {
    const port = new URL(raw).port
    if (!port) return null
    const n = Number(port)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function killPidTree(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" })
    } else {
      execSync(`kill -9 ${pid}`, { stdio: "ignore" })
    }
  } catch {
    /* already gone */
  }
}

function killPortListeners(port: number): void {
  if (process.platform === "win32") {
    try {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8" })
      const pids = new Set<string>()
      for (const line of out.split("\n")) {
        const match = line.match(/LISTENING\s+(\d+)/)
        if (match?.[1]) pids.add(match[1])
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" })
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* nothing listening */
    }
    return
  }

  try {
    const out = execSync(`lsof -ti :${port}`, { encoding: "utf8" })
    for (const pid of out.trim().split(/\s+/)) {
      try {
        execSync(`kill -9 ${pid}`, { stdio: "ignore" })
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* nothing listening */
  }
}

/** Free the upstream port and any stale app PID before spawning Vite. */
export function freeProxyDevPort(pidDir: string, port: number): void {
  const stalePid = readPid(pidDir, "app")
  if (stalePid) killPidTree(stalePid)
  killPortListeners(port)
}

/**
 * When a package.json script only runs Vite, spawn node + vite.js directly.
 * Avoids Windows shell shims (pnpm → bash → vite) that orphan the real server
 * and break PID-based cleanup / auto-restart.
 */
export function resolveViteDirectSpawn(
  appDir: string,
  script: string,
  scripts: Record<string, string> | undefined,
): { bin: string; args: string[]; shell: boolean } | null {
  const body = scripts?.[script]?.trim() ?? ""
  if (!body) return null

  const runsVite =
    body === "vite" ||
    /^vite\s/.test(body) ||
    body.includes("vite/bin/vite")

  if (!runsVite) return null

  const viteJs = join(appDir, "node_modules", "vite", "bin", "vite.js")
  if (!existsSync(viteJs)) return null

  return { bin: process.execPath, args: [viteJs], shell: false }
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

  const upstreamPort = portFromUpstream(config)
  const directVite = resolveViteDirectSpawn(appDir, script, pkg.scripts)
  const pm = detectPackageManager(appDir)
  const bin = directVite?.bin ?? pm
  const args = directVite?.args ?? (pm === "yarn" ? [script] : ["run", script])
  const useShell = directVite ? false : process.platform === "win32"

  appendDevTaskLog(
    "app",
    "app",
    directVite
      ? `Proxy mode: running node vite.js (${appDir})`
      : `Proxy mode: running ${bin} ${args.join(" ")} (${appDir})`,
  )

  if (upstreamPort) freeProxyDevPort(pidDir, upstreamPort)

  const manager = new ProcessManager(bin, args, {
    label: "app",
    pidDir,
    cwd: appDir,
    colour: "\x1b[33m",
    shell: useShell,
    ...(upstreamPort ? { beforeRestart: () => freeProxyDevPort(pidDir, upstreamPort) } : {}),
  })
  manager.start()
  return manager
}
