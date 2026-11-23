import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The functions' local env file, beside them in the functions directory. */
export const FUNCTIONS_ENV_LOCAL = ".env.local"

/**
 * One function's own local env file, which the worker merges over {@link FUNCTIONS_ENV_LOCAL}, so
 * a value here overrides a shared one.
 */
export const functionEnvLocalName = (fn: string): string => `.env.${fn}.local`

const TEMPLATE =
  "# Local environment variables for edge functions\n# These are NOT committed to git\n# Set production env vars via: npx supatype functions env set KEY=value\n"

/**
 * Create the functions' local env file with its header, and the functions directory with it, when
 * the file is not there. One writer for `init`, `functions new` and `functions env set`: the last
 * failed with ENOENT in a project with no functions directory (issue 70). Returns its path and
 * whether it was created. With `fn` it is that function's own file ({@link functionEnvLocalName}).
 */
export function ensureFunctionsEnvLocal(functionsDir: string, fn?: string): { path: string; created: boolean } {
  const path = join(functionsDir, fn === undefined ? FUNCTIONS_ENV_LOCAL : functionEnvLocalName(fn))
  if (existsSync(path)) return { path, created: false }
  mkdirSync(functionsDir, { recursive: true })
  writeFileSync(path, TEMPLATE, "utf8")
  return { path, created: true }
}
