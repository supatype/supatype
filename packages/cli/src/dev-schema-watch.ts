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
import { debounce } from "./debounce.js"
import type { WatchFn } from "./dev-functions-watch.js"

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

/** What the push is told when an event named no `.ts` file but the schema changed. */
export const CHANGED_ON_DISK = "Change detected in the schema"

/**
 * Watch `dir` and push once per burst of events, and once now if the schema was saved after the
 * first push read it.
 *
 * A burst that names a `.ts` file pushes, naming the last one. Any other burst, which is how a save
 * made by renaming another file over the schema can arrive (`sed -i`, some editors), pushes when the
 * schema on disk changed: such a save was ignored, and the database kept the old schema (issue 66).
 */
export function watchDevSchema(opts: DevSchemaWatchOptions, watch: WatchFn = fsWatch): { close: () => void } {
  let saved: string | undefined
  const settle = debounce(() => {
    const name = saved
    saved = undefined
    if (name !== undefined) opts.push(`Change detected in ${name}`)
    else void pushIfChanged(opts, CHANGED_ON_DISK)
  })
  const watcher = watch(opts.dir, { recursive: true }, (_event, filename) => {
    if (filename?.endsWith(".ts")) saved = filename
    settle.trigger()
  })
  void pushIfChanged(opts, CHANGED_WHILE_STARTING)
  return {
    close: () => {
      settle.cancel()
      watcher.close()
    },
  }
}

/** A schema that cannot be read now is pushed too: the push is what says what is wrong with it. */
async function pushIfChanged(opts: DevSchemaWatchOptions, why: string): Promise<void> {
  const changed = await Promise.resolve()
    .then(opts.changedSinceLastPush)
    .catch(() => true)
  if (changed) opts.push(why)
}
