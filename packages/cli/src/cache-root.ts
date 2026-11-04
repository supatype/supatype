import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Where the CLI keeps what it downloads: component binaries, and the program the npm package's
 * starter runs. Its own module, with nothing but Node's, because the starter reads it before every
 * command and pays for each module it loads.
 */
export function cacheRoot(home: string = homedir()): string {
  return join(home, ".supatype", "cache")
}
