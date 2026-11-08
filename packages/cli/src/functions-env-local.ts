import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The functions' local env file, beside them in the functions directory. */
export const FUNCTIONS_ENV_LOCAL = ".env.local"

const TEMPLATE =
  "# Local environment variables for edge functions\n# These are NOT committed to git\n# Set production env vars via: npx supatype functions env set KEY=value\n"

/**
 * Create the functions' local env file with its header, and the functions directory with it, when
 * the file is not there. One writer for `init`, `functions new` and `functions env set`: the last
 * failed with ENOENT in a project with no functions directory (issue 70). Returns its path and
 * whether it was created.
 */
export function ensureFunctionsEnvLocal(functionsDir: string): { path: string; created: boolean } {
  const path = join(functionsDir, FUNCTIONS_ENV_LOCAL)
  if (existsSync(path)) return { path, created: false }
  mkdirSync(functionsDir, { recursive: true })
  writeFileSync(path, TEMPLATE, "utf8")
  return { path, created: true }
}
