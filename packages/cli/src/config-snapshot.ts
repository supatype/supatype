/**
 * The project config's bytes, for telling whether it changed without loading it: loading runs the
 * config. Kept apart from the watchers, so dev can take one as it starts without loading them.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * A hash of each config file's bytes, empty for one not there, or null when one could not be read
 * (an editor mid-replace): then the config is loaded, which says what is wrong if anything is.
 */
export function configSnapshot(dir: string, configFiles: readonly string[]): string | null {
  try {
    return configFiles
      .map((file) => join(dir, file))
      .map((path) => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : ""))
      .join(",")
  } catch {
    return null
  }
}
