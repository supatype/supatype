/**
 * Ports given in the shell for one run, kept out of `.env` (DR9).
 *
 * `SUPATYPE_KONG_PORT=18990 supatype dev` is a port for that run. Docker Compose reads the shell
 * ahead of `.env`, so the run binds it either way, but `dev` also wrote it, and every value built
 * from it, into `.env`, where the throwaway port became the project's port for every later run.
 * A shell-only port is now treated like `SUPATYPE_PROJECT_NAME`: the run uses it and nothing that
 * outlives the run records it.
 *
 * "Uses it" includes the values derived from it. They go into this process's environment instead
 * of `.env`, so compose, the app's dev server and the CLI's own connections, which all read the
 * environment ahead of `.env`, see the run's port.
 */

/** The `.env` keys `dev` builds from each port, by the variable that sets the port. */
const DERIVED_FROM_PORT: Readonly<Record<string, readonly string[]>> = {
  SUPATYPE_KONG_PORT: [
    "SUPATYPE_KONG_PORT",
    "API_EXTERNAL_URL",
    "SITE_URL",
    "VITE_SUPATYPE_URL",
    "PUBLIC_SUPATYPE_URL",
    "EXPO_PUBLIC_SUPATYPE_URL",
  ],
  SUPATYPE_DEV_DB_PORT: ["SUPATYPE_DEV_DB_PORT", "DATABASE_URL"],
}

/** `.env` updates divided into what is written and what holds for this run only. */
export interface ShellPortUpdates {
  persist: Record<string, string>
  runOnly: Record<string, string>
}

/** True when the shell sets `key` to something. */
function setInShell(env: NodeJS.ProcessEnv, key: string): boolean {
  return (env[key]?.trim() ?? "") !== ""
}

/** The keys derived from a port the shell set. */
function runOnlyKeys(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    Object.entries(DERIVED_FROM_PORT).flatMap(([port, keys]) => (setInShell(env, port) ? keys : [])),
  )
}

/** Split `updates` into those `.env` keeps and those built from a port only the shell set. */
export function splitShellPortUpdates(
  updates: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): ShellPortUpdates {
  const runOnly = runOnlyKeys(env)
  const split: ShellPortUpdates = { persist: {}, runOnly: {} }
  for (const [key, value] of Object.entries(updates)) {
    if (runOnly.has(key)) split.runOnly[key] = value
    else split.persist[key] = value
  }
  return split
}

/**
 * Put run-only values into this process's environment, which compose and every child inherits.
 * A value the shell already sets is left alone: the shell's own setting is the one the run meant.
 */
export function applyForThisRun(values: Record<string, string>, env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(values)) {
    if (!setInShell(env, key)) env[key] = value
  }
}
