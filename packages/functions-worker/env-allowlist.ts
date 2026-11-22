/**
 * The process environment function code may see, and the scrub that enforces it.
 *
 * `Deno.env` is the worker's one process environment, and a function imported here reads it. Native
 * `supatype dev` started the worker with the server's whole environment, which held the stack's JWT
 * secret, the database URL and everything in the developer's shell (e2e 2026-11-21, RB-2). Deleting
 * the variables off this list before the first function is imported means a launcher that passes
 * too much no longer decides what a function can read. The server applies the same list when it
 * starts Deno (supatype-auth `internal/deno/allowlist.go`), so the two are kept in step by hand.
 *
 * A function's own values arrive in `ctx.env` from the env files, never through here.
 */

/** What Deno itself and the operating system need to run, fetch and resolve modules. */
const RUNTIME_NAMES = [
  "PATH", "PATHEXT", "HOME", "USER", "USERNAME", "LOGNAME", "TMPDIR", "TEMP", "TMP", "TZ", "LANG",
  "LC_ALL", "LC_CTYPE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "NO_COLOR",
  // Windows: the profile and cache directories, and what its networking and process APIs read.
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC",
  "PROGRAMDATA", "HOMEDRIVE", "HOMEPATH",
  // Deno honours these for fetch and for npm: and jsr: imports.
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NPM_CONFIG_REGISTRY",
]

/** What this worker reads (main.ts, logging.ts, stop.ts), and what it hands a function as ctx fields. */
const WORKER_NAMES = [
  "PORT", "SUPATYPE_FUNCTIONS_ROOT", "SUPATYPE_DENO_FUNCTIONS_DIR", "SUPATYPE_HOOKS_ROOT",
  "SUPATYPE_FUNCTION_NAME", "SUPATYPE_FUNCTIONS_HOST", "SUPATYPE_FUNCTIONS_DRAIN_MS",
  "SUPATYPE_SERVICE_ROLE_ROUTES", "SUPATYPE_SERVICE_ROLE_ROUTES_FILE", "SUPATYPE_SERVICE_ROLE_KEY_FILE",
  "SUPATYPE_MANIFEST_PATH", "SUPATYPE_SHARED_ENV_FILE", "SUPATYPE_FUNCTION_ENV_FILE",
  "SUPATYPE_LOG_TAIL_BUFFER", "SUPATYPE_PROJECT_REF", "SUPATYPE_MANAGED_PROJECT_REF",
  "DEDICATED_PROJECT_REF", "SUPATYPE_URL", "SUPATYPE_INTERNAL_URL", "SUPATYPE_PUBLIC_URL",
  "SUPATYPE_ANON_KEY", "SUPATYPE_REGION", "SUPATYPE_DB_URL",
]

/**
 * What self-host compose lists for the worker container on purpose, and documents as passed to it
 * (self-hosting/configuration.mdx). Only a deployment that names them sets them.
 */
const DEPLOYMENT_NAMES = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "SITE_URL"]

/** Deno's own settings: its cache directory, certificate store and registry tokens. */
const ALLOWED_PREFIXES = ["DENO_"]

const ALLOWED_NAMES = new Set([...RUNTIME_NAMES, ...WORKER_NAMES, ...DEPLOYMENT_NAMES])

/**
 * Whether function code may see `name`. Case-insensitive: Windows spells `PATH` as `Path`, and its
 * environment does not tell the two apart.
 */
export function envNameAllowed(name: string): boolean {
  const upper = name.toUpperCase()
  return ALLOWED_NAMES.has(upper) || ALLOWED_PREFIXES.some((prefix) => upper.startsWith(prefix))
}

/**
 * Whether Deno can delete `name`. Windows keeps each drive's working directory as a hidden `=D:`
 * variable, which `toObject` lists and `delete` refuses ("Key contains invalid characters"), so
 * trying stopped the worker starting. It holds a path, never a secret.
 */
function deletable(name: string): boolean {
  return name !== "" && !name.includes("=") && !name.includes("\0")
}

/** Deletes every variable off the allowlist from this process's environment. */
export function scrubProcessEnv(): void {
  for (const name of Object.keys(Deno.env.toObject())) {
    if (deletable(name) && !envNameAllowed(name)) Deno.env.delete(name)
  }
}
