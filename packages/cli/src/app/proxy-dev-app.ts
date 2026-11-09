/**
 * Spawn the frontend dev server during `supatype dev` when app.mode is proxy.
 */

import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { detectPackageManager } from "./framework.js"
import { nodeExecutable } from "../node-executable.js"
import { parsePackageJson } from "../package-json.js"
import { appendDevTaskLog } from "../dev-session.js"
import { DEV_APP_ENV, SELF_START_EXIT_CODE, runsSupatypeDev, selfStartProblem } from "../dev-self-start.js"
import { ProcessManager, readPid } from "../process-manager.js"
import { projectRootFromConfig, type SupatypeProjectConfig } from "../project-config.js"

/** The script dev runs as the app when `app.start` names none. */
export const DEFAULT_PROXY_DEV_SCRIPT = "start"

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

/** Runs a command without a shell or a console window, and resolves with its stdout. */
function runCommand(bin: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: "utf8", windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

async function killPidTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return
  const [bin, args] =
    process.platform === "win32" ? ["taskkill", ["/pid", String(pid), "/T", "/F"]] : ["kill", ["-9", String(pid)]]
  await runCommand(bin, args).catch(() => {
    /* already gone */
  })
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
  if (process.platform === "win32") return netstatListeners(await runCommand("netstat", ["-ano"]), port)
  const out = await runCommand("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"]).catch((err: unknown) => {
    if (typeof err === "object" && err !== null && "code" in err && err.code === 1) return ""
    throw err
  })
  return out.split(/\s+/).filter((pid) => pid !== "").map(Number)
}

/**
 * Free the upstream port and any stale app PID before spawning the app. Asynchronous: run
 * synchronously, the port scan took ten seconds on Windows and froze the dashboard while it did.
 * Rejects when the port could not be scanned.
 */
export async function freeProxyDevPort(pidDir: string, port: number): Promise<void> {
  const stalePid = readPid(pidDir, "app")
  if (stalePid) await killPidTree(stalePid)
  await Promise.all((await listenerPids(port)).map(killPidTree))
}

/**
 * When a package.json script only runs Vite, spawn node + vite.js directly.
 * Avoids Windows shell shims (pnpm → bash → vite) that orphan the real server
 * and break PID-based cleanup / auto-restart. Throws when the compiled binary
 * finds no Node to run vite.js with (see node-executable.ts).
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

  return { bin: nodeExecutable(viteJs), args: [viteJs], shell: false }
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
  const directVite = resolveViteDirectSpawn(appDir, script, pkg.scripts)
  const pm = detectPackageManager(appDir)
  const bin = directVite?.bin ?? pm
  const args = directVite?.args ?? (pm === "yarn" ? [script] : ["run", script])
  const useShell = directVite ? false : process.platform === "win32"

  appendDevTaskLog("app", "app", `Proxy mode: running ${bin} ${args.join(" ")} (${appDir})`)

  // Run by the manager before each spawn, so the scan never holds up the dashboard.
  const freePort = upstreamPort ? () => freeProxyDevPort(pidDir, upstreamPort) : undefined
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
