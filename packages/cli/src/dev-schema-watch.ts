/**
 * Push the schema when a `supatype dev` session's schema sources change.
 *
 * Both providers read the schema for the first push, then bring the rest of the stack up, and only
 * then start watching. With docker that is minutes of `compose up` and health checks, and a save in
 * that window was never seen: the database kept the schema read at start-up while the file said
 * otherwise, and the next save that put the file back printed "pushing schema..." over a push that
 * had nothing to do, which read as dev hanging.
 */
import { watch as fsWatch } from "node:fs"
import type { WatchFn } from "./dev-functions-watch.js"

/** Windows fires several events per save; one push covers them all. */
const DEBOUNCE_MS = 300

export interface DevSchemaWatchOptions {
  /** The directory holding the schema entry point and the files it imports. */
  dir: string
  /** Whether the schema on disk is not the one the last push read. */
  changedSinceLastPush: () => boolean | Promise<boolean>
  /** Push the schema as a save does. `why` is what the log line says set it off. */
  push: (why: string) => void
}

/** What the push is told when the schema was saved before the watch started. */
export const CHANGED_WHILE_STARTING = "The schema changed while dev was starting"

/**
 * Watch `dir` and push once per burst of saves to a `.ts` file, and once now if the schema was
 * saved after the first push read it.
 */
export function watchDevSchema(opts: DevSchemaWatchOptions, watch: WatchFn = fsWatch): { close: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const watcher = watch(opts.dir, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith(".ts")) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      opts.push(`Change detected in ${filename}`)
    }, DEBOUNCE_MS)
  })
  void catchUpOnEarlierSave(opts)
  return {
    close: () => {
      if (timer) clearTimeout(timer)
      timer = null
      watcher.close()
    },
  }
}

/** A schema that cannot be read now is pushed too: the push is what says what is wrong with it. */
async function catchUpOnEarlierSave(opts: DevSchemaWatchOptions): Promise<void> {
  const changed = await Promise.resolve()
    .then(opts.changedSinceLastPush)
    .catch(() => true)
  if (changed) opts.push(CHANGED_WHILE_STARTING)
}
