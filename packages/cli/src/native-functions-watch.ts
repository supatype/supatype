/**
 * Keep native dev's functions worker serving every function and model hook, so one added while dev
 * runs is served.
 *
 * Native dev's server runs Deno with `--watch` on `.supatype/functions-worker.ts`, an entry that
 * imports the functions worker. Deno reloads when a file the worker imported changes, but a
 * function or hook added afterwards was imported by nothing. The entry names the routes found, and
 * is rewritten when that set changes, so Deno's watch reloads the worker, which finds the new one.
 *
 * The worker runs on every native dev, with or without a function or hook yet (native-worker.ts):
 * the server's environment is fixed at spawn, so a project with neither directory when dev started
 * used to need `supatype dev` restarted for its first one (local test round 3d, N19).
 */
import { existsSync, watch as fsWatch } from "node:fs"
import { basename, dirname } from "node:path"
import { errorMessage } from "./error-message.js"
import { localWorkerRoutes, writeDevFunctionsEntry, writeServiceRoleRoutesFile } from "./functions-worker-files.js"
import type { WatchFn } from "./dev-functions-watch.js"

/** Windows fires several events per save; one rewrite covers them all. */
const DEBOUNCE_MS = 300

/** Native dev's worker: the project it serves and the worker main.ts its entry imports. */
export interface NativeFunctionsTarget {
  cwd: string
  /** The functions directory, when the project has one. */
  functionsDir: string | undefined
  hooksDir: string
  workerMain: string
}

/**
 * Rewrite the entry when the routes on disk differ from `known`. Returns the new routes when it
 * rewrote, and null when nothing changed or the directories could not be read as handlers.
 */
export function refreshNativeFunctionsEntry(target: NativeFunctionsTarget, known: readonly string[]): string[] | null {
  let routes: string[]
  try {
    routes = localWorkerRoutes(target.functionsDir, target.hooksDir)
    if (routes.join("\n") === known.join("\n")) return null
    writeDevFunctionsEntry(target.cwd, routes, target.workerMain)
  } catch (err) {
    console.warn(`[supatype] Could not reload the functions worker: ${errorMessage(err)}`)
    return null
  }
  console.log(`[supatype] Functions changed (${routes.join(", ")}); Deno reloads the worker.`)
  return routes
}

/**
 * Watch the functions and hooks directories and reload the worker whenever their routes change. A
 * directory not there yet is watched for in its parent, and from when it appears. `refresh` checks
 * at once, for the schema watch after a push: a hook the push just declared is served then.
 */
export function watchNativeFunctions(
  target: NativeFunctionsTarget,
  initial: readonly string[],
  watch: WatchFn = fsWatch,
): { close: () => void; refresh: () => void; reload: () => void } {
  let known = [...initial]
  let timer: ReturnType<typeof setTimeout> | null = null
  const refresh = (): void => {
    known = refreshNativeFunctionsEntry(target, known) ?? known
  }
  const onChange = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      refresh()
    }, DEBOUNCE_MS)
  }
  const dirs = [target.functionsDir, target.hooksDir].filter((dir): dir is string => dir !== undefined)
  const watchers = watchDirsAsMade(dirs, onChange, watch)
  return {
    refresh,
    // The entry written again as it is: Deno's --watch restarts the worker, which re-reads its files.
    reload: () => writeDevFunctionsEntry(target.cwd, known, target.workerMain),
    close: () => {
      if (timer) clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
    },
  }
}

/**
 * Each of `dirs` watched with `onChange`: at once when it is there, else from when it appears in
 * its parent, which is then told as a change. A directory whose parent is not there either is left
 * to `refresh`.
 */
function watchDirsAsMade(dirs: readonly string[], onChange: () => void, watch: WatchFn): { close: () => void }[] {
  const watchers: { close: () => void }[] = []
  const watched = new Set<string>()
  const watchDir = (dir: string): boolean => {
    if (watched.has(dir) || !existsSync(dir)) return false
    watched.add(dir)
    watchers.push(watch(dir, { recursive: true }, onChange))
    return true
  }
  for (const dir of dirs) {
    if (watchDir(dir) || !existsSync(dirname(dir))) continue
    watchers.push(watch(dirname(dir), { recursive: false }, (_event, filename) => {
      if (filename === basename(dir) && watchDir(dir)) onChange()
    }))
  }
  return watchers
}

/** What native dev needs to keep the worker's `functions.serviceRole` in step with the config. */
export interface ServiceRoleRoutesTarget {
  routesPath: string
  /** `functions.serviceRole` as the config says now. */
  readRoutes: () => string[]
  /** Restarts the worker, which reads the routes file again. */
  reload: () => void
}

/**
 * When the config's `functions.serviceRole` differs from `known`, writes the routes file and reloads
 * the worker, saying so. Returns the list now in force, or null when nothing changed. Without this a
 * change waited, silently, for `supatype dev` to be restarted.
 */
export function refreshServiceRoleRoutes(target: ServiceRoleRoutesTarget, known: readonly string[]): string[] | null {
  let routes: string[]
  try {
    routes = target.readRoutes()
  } catch (err) {
    console.warn(`[supatype] Could not read functions.serviceRole: ${errorMessage(err)}`)
    return null
  }
  if (routes.join(",") === known.join(",")) return null
  writeServiceRoleRoutesFile(target.routesPath, routes)
  target.reload()
  console.log(`[supatype] functions.serviceRole changed (${routes.join(", ") || "none"}); Deno reloads the worker.`)
  return routes
}

/**
 * Watches `dir` for a change to any of `configFiles` (the directory, as editors replace the file) and
 * applies a `functions.serviceRole` change.
 */
export function watchServiceRoleRoutes(
  dir: string,
  configFiles: readonly string[],
  target: ServiceRoleRoutesTarget,
  initial: readonly string[],
  watch: WatchFn = fsWatch,
): { close: () => void } {
  let known = [...initial]
  let timer: ReturnType<typeof setTimeout> | null = null
  const watcher = watch(dir, { recursive: false }, (_event, filename) => {
    if (typeof filename !== "string" || !configFiles.includes(filename)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      known = refreshServiceRoleRoutes(target, known) ?? known
    }, DEBOUNCE_MS)
  })
  return { close: () => { if (timer) clearTimeout(timer); watcher.close() } }
}
