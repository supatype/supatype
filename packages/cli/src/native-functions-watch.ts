/**
 * Keep native dev's functions worker serving every function and model hook, so one added while dev
 * runs is served.
 *
 * Native dev's server runs Deno with `--watch` on `.supatype/functions-worker.ts`, an entry that
 * imports the functions worker. Deno reloads when a file the worker imported changes, but a
 * function or hook added afterwards was imported by nothing. The entry names the routes found, and
 * is rewritten when that set changes, so Deno's watch reloads the worker, which finds the new one.
 *
 * What it cannot do: a project with neither a functions/ nor a hooks/ directory when dev started
 * has a server started with no Deno at all (its environment is fixed at spawn), so the first
 * function or hook in such a project still needs `supatype dev` restarted.
 */
import { existsSync, watch as fsWatch } from "node:fs"
import { errorMessage } from "./error-message.js"
import { localWorkerRoutes, writeDevFunctionsEntry } from "./functions-worker-files.js"
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

/** Watch the functions and hooks directories and reload the worker whenever their routes change. */
export function watchNativeFunctions(
  target: NativeFunctionsTarget,
  initial: readonly string[],
  watch: WatchFn = fsWatch,
): { close: () => void } {
  let known = [...initial]
  let timer: ReturnType<typeof setTimeout> | null = null
  const onChange = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      known = refreshNativeFunctionsEntry(target, known) ?? known
    }, DEBOUNCE_MS)
  }
  const dirs = [target.functionsDir, target.hooksDir].filter((dir): dir is string => dir !== undefined && existsSync(dir))
  const watchers = dirs.map((dir) => watch(dir, { recursive: true }, onChange))
  return {
    close: () => {
      if (timer) clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
    },
  }
}
