/**
 * Spawn the frontend dev server during `supatype dev` when app.mode is proxy.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { detectPackageManager } from "./framework.js"
import { nodeExecutable } from "../node-executable.js"
import { viteScriptArgs, viteUpstreamFlags } from "./vite-dev-args.js"
import { appOwnership, type AppIdentity } from "./port-holder.js"
import { parsePackageJson } from "../package-json.js"
import { pidAlive } from "../parent-watch.js"
import { runCaptured, type CapturedRun } from "../run-captured.js"
import { appendDevTaskLog } from "../dev-session.js"
import { DEV_APP_ENV, SELF_START_EXIT_CODE, runsSupatypeDev, selfStartProblem } from "../dev-self-start.js"
import { ProcessManager, readPid } from "../process-manager.js"
import { killPidTree } from "../process-tree.js"
import { projectRootFromConfig, type SupatypeProjectConfig } from "../project-config.js"

/** The script dev runs as the app when `app.start` names none. */
export const DEFAULT_PROXY_DEV_SCRIPT = "start"

/** package.json script name to run (only when app.mode is proxy). */
export function resolveProxyDevScript(config: SupatypeProjectConfig): string | null {
  if (config.app?.mode !== "proxy") return null
  const script = config.app.start?.trim()
  return script && script.length > 0 ? script : DEFAULT_PROXY_DEV_SCRIPT
}

/**
 * The dev panel's App link, at `/` of the gateway at `base`, for an app Supatype serves there:
 * built files (`static`) or a dev server it forwards to (`proxy`). A static app had none, and native
 * dev listed no App at all (0.9.2 release test round 2).
 */
export function appPanelLinks(config: SupatypeProjectConfig, base: string): Array<{ label: string; url: string }> {
  const mode = config.app?.mode
  return mode === "static" || mode === "proxy" ? [{ label: "App", url: `${base}/` }] : []
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

/**
 * The PIDs listening on `port` in `netstat -ano` output. Only the local address is matched, and
 * all of it: `findstr :5285` also matched port 52851, and a connection to the port from elsewhere.
 */
export function netstatListeners(out: string, port: number): number[] {
  const pids = new Set<number>()
  for (const line of out.split(/\r?\n/)) {
    const [proto, local, , state, pid] = line.trim().split(/\s+/)
    if (proto !== "TCP" || state !== "LISTENING" || !local?.endsWith(`:${port}`)) continue
    const n = Number(pid)
    if (Number.isInteger(n) && n > 0) pids.add(n)
  }
  return [...pids]
}

/** The PIDs listening on `port`. `lsof` exits 1 when nothing is, which is not a failure. */
async function listenerPids(port: number): Promise<number[]> {
  if (process.platform === "win32") return netstatListeners(scanOutput(port, await runCaptured("netstat", ["-ano"])), port)
  const scan = await runCaptured("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"])
  if (scan.status === 1) return []
  return scanOutput(port, scan)
    .split(/\s+/)
    .filter((pid) => pid !== "")
    .map(Number)
}

/** What a port scan printed; throws when it failed. */
function scanOutput(port: number, scan: CapturedRun): string {
  if (scan.status === 0) return scan.stdout
  throw new Error(`could not list what listens on port ${port}: ${scan.error ?? scan.stderr.trim()}`)
}

/** The PID file's app PID while that process still runs: one that has ended has nothing to end. */
function runningStalePid(pidDir: string): number | null {
  const pid = readPid(pidDir, "app")
  return pid !== null && pidAlive(pid) ? pid : null
}

/**
 * Free the upstream port and any stale app PID before spawning the app, ending only processes that
 * belong to this app (see port-holder.ts). Resolves with the PID of another program holding the
 * port, which is left running, or null when the port is free for the app. Asynchronous: run
 * synchronously, the port scan took ten seconds on Windows and froze the dashboard while it did.
 * Every candidate is looked up in one call, since each lookup starts PowerShell on Windows.
 * Rejects when the port could not be scanned.
 */
export async function freeProxyDevPort(pidDir: string, port: number, app: AppIdentity): Promise<number | null> {
  const stalePid = runningStalePid(pidDir)
  const listeners = [...new Set(await listenerPids(port))]
  const owned = await appOwnership(stalePid === null ? listeners : [stalePid, ...listeners], app)
  if (stalePid !== null && owned.get(stalePid) === true) await killPidTree(stalePid)
  const foreign = listeners.find((pid) => owned.get(pid) !== true)
  if (foreign !== undefined) return foreign
  await Promise.all(listeners.filter((pid) => pid !== stalePid).map(killPidTree))
  return null
}

/**
 * Frees the app's port before a start. When another program holds it, says so and stops the app
 * instead: starting anyway would fail on the port or, before 0.9.2, end the other program.
 */
async function claimAppPort(pidDir: string, port: number, app: AppIdentity, stopApp: () => void): Promise<void> {
  const foreign = await freeProxyDevPort(pidDir, port, app)
  if (foreign === null) return
  appendDevTaskLog("app", "app", `port ${port} is used by another program (pid ${foreign})`, "error")
  stopApp()
}

/**
 * When a package.json script only runs Vite, spawn node + vite.js directly.
 * Avoids Windows shell shims (pnpm → bash → vite) that orphan the real server
 * and break PID-based cleanup / auto-restart. Throws when the compiled binary
 * finds no Node to run vite.js with (see node-executable.ts).
 *
 * The script's own arguments are passed on (they were dropped, so `vite --port 3000` ran on 5173),
 * then the flags that bind Vite to `upstream` (see vite-dev-args.ts).
 */
export function resolveViteDirectSpawn(
  appDir: string,
  script: string,
  scripts: Record<string, string> | undefined,
  upstream?: string,
): { bin: string; args: string[]; shell: boolean } | null {
  const scriptArgs = viteScriptArgs(scripts?.[script]?.trim() ?? "")
  if (!scriptArgs) return null

  const viteJs = join(appDir, "node_modules", "vite", "bin", "vite.js")
  if (!existsSync(viteJs)) return null

  const args = [viteJs, ...scriptArgs, ...viteUpstreamFlags(scriptArgs, upstream)]
  return { bin: nodeExecutable(viteJs), args, shell: false }
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

  const pkg = parsePackageJson(readFileSync(pkgPath, "utf8"))
  const body = pkg.scripts[script]
  if (!body) {
    console.warn(
      `[supatype] app.mode=proxy: package.json has no "${script}" script.\n` +
        `  Add "scripts.${script}" or set app.start in supatype.config.ts`,
    )
    return null
  }
  if (runsSupatypeDev(body)) {
    console.warn(`[supatype] ${selfStartProblem(script)}`)
    return null
  }

  const upstreamPort = portFromUpstream(config)
  const directVite = resolveViteDirectSpawn(appDir, script, pkg.scripts, config.app?.upstream)
  const pm = detectPackageManager(appDir)
  const bin = directVite?.bin ?? pm
  const args = directVite?.args ?? (pm === "yarn" ? [script] : ["run", script])
  const useShell = directVite ? false : process.platform === "win32"

  appendDevTaskLog("app", "app", `Proxy mode: running ${bin} ${args.join(" ")} (${appDir})`)

  // Run by the manager before each spawn, so the scan never holds up the dashboard. Stopping the
  // manager from inside the hook is what keeps the spawn that follows it from happening.
  const app = { dir: appDir, command: `${bin} ${args.join(" ")}` }
  const freePort = upstreamPort
    ? () => claimAppPort(pidDir, upstreamPort, app, () => void manager.stop())
    : undefined
  const manager = new ProcessManager(bin, args, {
    label: "app",
    pidDir,
    cwd: appDir,
    colour: "\x1b[33m",
    shell: useShell,
    env: { [DEV_APP_ENV]: "1" },
    finalExitCode: SELF_START_EXIT_CODE,
    ...(freePort && { beforeStart: freePort, beforeRestart: freePort }),
  })
  manager.start()
  return manager
}
