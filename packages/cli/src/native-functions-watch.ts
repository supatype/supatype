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
import { configSnapshot } from "./config-snapshot.js"
import { debounce } from "./debounce.js"
import { errorMessage } from "./error-message.js"
import { entryAdapterHash, hooksAdapterHash, localWorkerRoutes, writeDevFunctionsEntry, writeServiceRoleRoutesFile } from "./functions-worker-files.js"
import type { WatchFn } from "./dev-functions-watch.js"

/** Native dev's worker: the project it serves and the worker main.ts its entry imports. */
export interface NativeFunctionsTarget {
  cwd: string
  /** The functions directory, when the project has one. */
  functionsDir: string | undefined
  hooksDir: string
  workerMain: string
}

/**
 * Rewrite the entry when the routes on disk differ from `known`, or the generated hooks adapter
 * differs from the one the entry was written with: a hook that failed to import the adapter before
 * a push wrote it is loaded again only then (round 6c, N30). Returns the routes when it rewrote, and
 * null when nothing changed or the directories could not be read as handlers.
 */
export function refreshNativeFunctionsEntry(target: NativeFunctionsTarget, known: readonly string[]): string[] | null {
  return refreshIfChanged({
    read: () => localWorkerRoutes(target.functionsDir, target.hooksDir),
    apply: (routes) => writeDevFunctionsEntry(target.cwd, routes, target.workerMain, target.hooksDir),
    label: "Functions",
    known,
    stale: () => hooksAdapterHash(target.hooksDir) !== entryAdapterHash(target.cwd),
  })
}

/** A list of routes to keep in force: how to read it now, how to apply it, and what it is called. */
interface RouteRefresh {
  read: () => string[]
  apply: (routes: string[]) => void
  /** What the log lines call the list. */
  label: string
  /** The list in force now. */
  known: readonly string[]
  /** Whether to apply the list though it equals `known`, for something it is applied with. */
  stale?: () => boolean
}

/**
 * Reads a list and, when it differs from `known`, applies it, saying so. Returns the list now in
 * force, or null when nothing changed or it could not be read or applied. It runs from a watcher's
 * timer, where a throw would end `supatype dev`, so a failure is a warning.
 */
function refreshIfChanged({ read, apply, label, known, stale }: RouteRefresh): string[] | null {
  let routes: string[]
  try {
    routes = read()
    if (routes.join("\n") === known.join("\n") && stale?.() !== true) return null
    apply(routes)
  } catch (err) {
    console.warn(`[supatype] Could not reload the functions worker for a ${label} change: ${errorMessage(err)}`)
    return null
  }
  console.log(`[supatype] ${label} changed (${routes.join(", ") || "none"}); Deno reloads the worker.`)
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
  const refresh = (): void => {
    known = refreshNativeFunctionsEntry(target, known) ?? known
  }
  const onChange = debounce(refresh)
  const dirs = [target.functionsDir, target.hooksDir].filter((dir): dir is string => dir !== undefined)
  const watchers = watchDirsAsMade(dirs, onChange.trigger, watch)
  return {
    refresh,
    // The entry written again as it is: Deno's --watch restarts the worker, which re-reads its files.
    reload: () => writeDevFunctionsEntry(target.cwd, known, target.workerMain, target.hooksDir),
    close: () => {
      onChange.cancel()
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
  const apply = (routes: string[]): void => {
    writeServiceRoleRoutesFile(target.routesPath, routes)
    target.reload()
  }
  return refreshIfChanged({ read: target.readRoutes, apply, label: "functions.serviceRole", known })
}

/** The project's config watched for a `functions.serviceRole` change. */
export interface ServiceRoleRoutesWatch extends ServiceRoleRoutesTarget {
  /** The project directory, which holds the config. */
  dir: string
  /** The names the config may have in `dir`. */
  configFiles: readonly string[]
  /** `functions.serviceRole` as the worker was started with. */
  initial: readonly string[]
  /** `configSnapshot` of the config `initial` was read from, taken before it was read. */
  baseline: string | null
}

/**
 * Watches `opts.dir` for a change to any of its config files (the directory, as editors replace the
 * file) and applies a `functions.serviceRole` change. The config is loaded again only when a file's
 * bytes changed: loading runs the config, and a save of the same text, or an editor touching the
 * file, changed nothing. Bytes that differ from `opts.baseline` already are applied at once: the
 * watch starts well after dev read the config, and an edit in between was otherwise never seen.
 */
export function watchServiceRoleRoutes(opts: ServiceRoleRoutesWatch, watch: WatchFn = fsWatch): { close: () => void } {
  let known = [...opts.initial]
  let snapshot = opts.baseline
  const onChange = debounce(() => {
    const now = configSnapshot(opts.dir, opts.configFiles)
    if (now !== null && now === snapshot) return
    snapshot = now
    known = refreshServiceRoleRoutes(opts, known) ?? known
  })
  const watcher = watch(opts.dir, { recursive: false }, (_event, filename) => {
    if (typeof filename === "string" && opts.configFiles.includes(filename)) onChange.trigger()
  })
  onChange.trigger()
  return { close: () => { onChange.cancel(); watcher.close() } }
}
