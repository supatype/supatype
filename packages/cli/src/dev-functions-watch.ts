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
import { watch as fsWatch, existsSync, statSync } from "node:fs"
import { join, basename } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { debounce } from "./debounce.js"
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

/**
 * Whether an event under a watched root is one the worker must restart for: a source file, or a
 * directory. A folder copied in arrives as an event for its own extensionless name, which the
 * source pattern alone dropped, and a function is a folder. A path that no longer exists and has no
 * extension is a deleted folder (or a deleted extensionless file, which the worker never imported,
 * and a spare restart is the cheap side of that doubt).
 */
function worthRestarting(root: string, filename: string | null): boolean {
  if (filename === null) return false
  if (SOURCE_FILE.test(filename)) return true
  const name = basename(filename)
  if (name.startsWith(".")) return false
  try {
    return statSync(join(root, filename)).isDirectory()
  } catch {
    return !name.includes(".")
  }
}

/**
 * Watch the project's functions/ and hooks/ and call `restart` once per burst of saves.
 *
 * The project root is watched too, for either directory appearing. Only the ones that existed when
 * dev started used to be watched, so in a project with no functions/ yet, `supatype functions new`
 * made a directory nothing watched: the new function was not served, and editing it changed nothing.
 */
export function watchFunctionSources(
  cwd: string,
  restart: () => void | Promise<void>,
  watch: WatchFn = fsWatch,
): { close: () => void } {
  const scheduled = debounce(() => {
    Promise.resolve(restart()).catch((err: unknown) => {
      console.warn(`[supatype] Restarting the functions worker failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  })
  const watchers = new Map<string, { close: () => void }>()
  const watchSourceDir = (dir: string): boolean => {
    const path = join(cwd, dir)
    if (watchers.has(dir) || !existsSync(path)) return false
    const onChange = (_event: string, filename: string | null) => {
      if (worthRestarting(path, filename)) scheduled.trigger()
    }
    watchers.set(dir, watch(path, { recursive: true }, onChange))
    return true
  }
  for (const dir of WORKER_SOURCE_DIRS) watchSourceDir(dir)
  const root = watch(cwd, { recursive: false }, (_event, filename) => {
    if (isWorkerSourceDir(filename) && watchSourceDir(filename)) scheduled.trigger()
  })
  return {
    close: () => {
      scheduled.cancel()
      root.close()
      for (const watcher of watchers.values()) watcher.close()
    },
  }
}

function isWorkerSourceDir(name: string | null): name is (typeof WORKER_SOURCE_DIRS)[number] {
  return WORKER_SOURCE_DIRS.some((dir) => dir === name)
}

/** Where a dev session's compose stack is, so its worker can be restarted and then asked if it is back. */
export interface ComposeWorkerTarget {
  composePath: string
  cwd: string
  project: string
  /** The gateway origin on the host, the only way in: the worker's own port is not published. */
  baseUrl: string
  anonKey: string | undefined
}

/** What the readiness wait needs from outside, so a test can stand in for each. */
export interface WorkerHealthDeps {
  /** The HTTP status `url` answers with; throws when nothing answers at all. */
  fetchStatus: (url: string, headers: Record<string, string>) => Promise<number>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

const HEALTH_WITHIN_MS = 30_000
const HEALTH_POLL_MS = 500

const liveHealthDeps: WorkerHealthDeps = {
  fetchStatus: async (url, headers) => (await fetch(url, { headers, signal: AbortSignal.timeout(2_000) })).status,
  sleep: (ms) => sleep(ms),
  now: () => Date.now(),
}

/**
 * True once the worker answers through the gateway. The worker has no health route and its port is
 * not published, so this asks for a function that does not exist: a worker that is up answers 404,
 * where a stopped one makes the gateway answer 502 or 503, or nothing. Anything below 500 is the
 * worker's own answer.
 */
export async function waitForWorkerHealth(
  target: Pick<ComposeWorkerTarget, "baseUrl" | "anonKey">,
  deps: WorkerHealthDeps = liveHealthDeps,
  withinMs: number = HEALTH_WITHIN_MS,
): Promise<boolean> {
  const url = `${target.baseUrl.replace(/\/+$/, "")}/functions/v1/_supatype_health`
  const headers: Record<string, string> = target.anonKey ? { apikey: target.anonKey } : {}
  const deadline = deps.now() + withinMs
  do {
    try {
      if ((await deps.fetchStatus(url, headers)) < 500) return true
    } catch {
      // Not answering yet: the container is still starting.
    }
    await deps.sleep(HEALTH_POLL_MS)
  } while (deps.now() < deadline)
  return false
}

/**
 * Restart the stack's functions worker so it imports the sources on disk again, and say
 * "restarted" only once it answers: docker returns when the container has started, which is
 * before the worker has imported anything, and writes made by a hook in that gap fail closed.
 */
export async function restartComposeFunctionsWorker(
  target: ComposeWorkerTarget,
  deps: WorkerHealthDeps = liveHealthDeps,
): Promise<void> {
  console.log("\n[supatype] Function source changed, restarting the functions worker...")
  const status = runDockerCompose(target.composePath, ["restart", "functions-worker"], target.cwd, target.project, {
    quiet: true,
  })
  if (status !== 0) {
    console.warn(
      `[supatype] Could not restart the functions worker (exit ${status}). ` +
        "Run `supatype self-host compose restart functions-worker` to load the change.",
    )
    return
  }
  if (await waitForWorkerHealth(target, deps)) {
    console.log("[supatype] Functions worker restarted; it serves the saved code.")
    return
  }
  console.warn(
    "[supatype] The functions worker was restarted but is not answering yet, so hooks may fail until it is. " +
      "See `supatype self-host compose logs --service functions-worker`.",
  )
}
