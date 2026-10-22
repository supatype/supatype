/**
 * Keep native dev's functions router listing every function, so a function added while dev runs is
 * served.
 *
 * Native dev's server runs Deno with `--watch` on `.supatype/functions-router.ts`, which the CLI
 * writes at start from the functions it finds then. Deno reloads when a listed function's file
 * changes, but a function added afterwards is imported by nothing, so it was never served. This
 * rewrites the router when the set of functions changes, and Deno's watch reloads it.
 *
 * What it cannot do: a project with no functions/ directory, or no function in it, when dev
 * started has a server started with no Deno router at all (its environment is fixed at spawn), so
 * the first function in such a project still needs `supatype dev` restarted.
 */
import { watch as fsWatch } from "node:fs"
import { errorMessage } from "./error-message.js"
import { discoverTsFunctionsInDir, writeDevFunctionsRouter } from "./functions-router-gen.js"
import type { WatchFn } from "./dev-functions-watch.js"

/** Windows fires several events per save; one rewrite covers them all. */
const DEBOUNCE_MS = 300

/**
 * Rewrite the router when the functions on disk differ from `known`. Returns the new sorted names
 * when it rewrote, and null when nothing changed or the directory could not be read as functions.
 */
export function refreshNativeFunctionsRouter(
  cwd: string,
  functionsDir: string,
  known: readonly string[],
): string[] | null {
  let names: string[]
  try {
    const routes = discoverTsFunctionsInDir(functionsDir)
    names = routes.map((route) => route.name).sort()
    if (names.join("\n") === [...known].sort().join("\n")) return null
    writeDevFunctionsRouter(cwd, functionsDir, routes)
  } catch (err) {
    console.warn(`[supatype] Could not regenerate the functions router: ${errorMessage(err)}`)
    return null
  }
  console.log(`[supatype] Functions router regenerated (${names.join(", ")}); Deno reloads it.`)
  return names
}

/** Watch `functionsDir` and regenerate the router whenever the set of functions changes. */
export function watchNativeFunctions(
  cwd: string,
  functionsDir: string,
  initial: readonly string[],
  watch: WatchFn = fsWatch,
): { close: () => void } {
  let known = [...initial]
  let timer: ReturnType<typeof setTimeout> | null = null
  const watcher = watch(functionsDir, { recursive: true }, () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      known = refreshNativeFunctionsRouter(cwd, functionsDir, known) ?? known
    }, DEBOUNCE_MS)
  })
  return {
    close: () => {
      if (timer) clearTimeout(timer)
      watcher.close()
    },
  }
}
