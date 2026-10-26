/**
 * Reload the compose functions worker when a function or hook source changes under `supatype dev`.
 *
 * The worker imports every handler once, when it starts, and serves those modules until it stops.
 * Native dev and `functions serve` reload because Deno runs with `--watch`; in a container that is
 * not enough, since file events from a Windows or macOS host do not reliably cross a Docker Desktop
 * bind mount, so an edit kept running the old code until somebody restarted the container by hand.
 * The CLI runs on the host, where every save is seen, so it restarts the worker instead. A restart
 * rather than a re-import also picks up a changed shared module and a newly added function.
 */
import { watch as fsWatch, existsSync } from "node:fs"
import { join } from "node:path"
import { runDockerCompose } from "./self-host-compose.js"

export type WatchFn = (
  dir: string,
  options: { recursive: boolean },
  listener: (event: string, filename: string | null) => void,
) => { close: () => void }

/** The worker's two roots, as the compose file mounts them from the project directory. */
const WORKER_SOURCE_DIRS = ["functions", "hooks"] as const

/** Source the worker imports. `.env*` files are read on every call, so they need no restart. */
const SOURCE_FILE = /\.(ts|tsx|js|mjs|json)$/

/** Windows fires several events per save; one restart covers them all. */
const DEBOUNCE_MS = 300

/**
 * Watch the project's functions/ and hooks/ and call `restart` once per burst of saves.
 *
 * The project root is watched too, for either directory appearing. Only the ones that existed when
 * dev started used to be watched, so in a project with no functions/ yet, `supatype functions new`
 * made a directory nothing watched: the new function was not served, and editing it changed nothing.
 */
export function watchFunctionSources(
  cwd: string,
  restart: () => void,
  watch: WatchFn = fsWatch,
): { close: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const scheduleRestart = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      restart()
    }, DEBOUNCE_MS)
  }
  const onChange = (_event: string, filename: string | null) => {
    if (filename !== null && SOURCE_FILE.test(filename)) scheduleRestart()
  }
  const watchers = new Map<string, { close: () => void }>()
  const watchSourceDir = (dir: string): boolean => {
    const path = join(cwd, dir)
    if (watchers.has(dir) || !existsSync(path)) return false
    watchers.set(dir, watch(path, { recursive: true }, onChange))
    return true
  }
  for (const dir of WORKER_SOURCE_DIRS) watchSourceDir(dir)
  const root = watch(cwd, { recursive: false }, (_event, filename) => {
    if (isWorkerSourceDir(filename) && watchSourceDir(filename)) scheduleRestart()
  })
  return {
    close: () => {
      if (timer) clearTimeout(timer)
      timer = null
      root.close()
      for (const watcher of watchers.values()) watcher.close()
    },
  }
}

function isWorkerSourceDir(name: string | null): name is (typeof WORKER_SOURCE_DIRS)[number] {
  return WORKER_SOURCE_DIRS.some((dir) => dir === name)
}

/** Where a dev session's compose stack is, so its worker can be restarted. */
export interface ComposeWorkerTarget {
  composePath: string
  cwd: string
  project: string
}

/** Restart the stack's functions worker, so it imports the sources on disk again. */
export function restartComposeFunctionsWorker(target: ComposeWorkerTarget): void {
  console.log("\n[supatype] Function source changed, restarting the functions worker...")
  const status = runDockerCompose(target.composePath, ["restart", "functions-worker"], target.cwd, target.project, {
    quiet: true,
  })
  if (status === 0) {
    console.log("[supatype] Functions worker restarted; it serves the saved code.")
    return
  }
  console.warn(
    `[supatype] Could not restart the functions worker (exit ${status}). ` +
      "Run `supatype self-host compose restart functions-worker` to load the change.",
  )
}
