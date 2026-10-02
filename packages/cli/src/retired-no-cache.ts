/**
 * `--no-cache` on `adopt` and `doctor`, which no longer read a cache at all.
 *
 * The engine diffed `adopt` against the snapshot the last push wrote, so a table changed outside
 * Supatype since was invisible to it (supatype#86). Both commands read the database live now, so
 * the flag has nothing left to bypass. It never worked from the CLI either: Commander stores
 * `--no-cache` as `cache: false`, the commands read `noCache`, and the flag was always ignored.
 *
 * Kept, hidden, for one release so a script that passes it keeps working, and says so.
 */
import { Option, type Command } from "commander"
import { warn } from "./ui/messages.js"

export function addRetiredNoCacheOption(command: Command): Command {
  return command.addOption(new Option("--no-cache", "No longer needed; does nothing").hideHelp())
}

/** Commander's spelling of a passed `--no-cache`. */
export interface RetiredNoCacheOpts {
  cache?: boolean
}

export function warnIfRetiredNoCache(opts: RetiredNoCacheOpts): void {
  if (opts.cache === false) {
    warn("--no-cache is no longer needed: the database is always read live. It will be removed.")
  }
}
