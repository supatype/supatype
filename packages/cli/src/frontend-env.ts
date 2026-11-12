/**
 * Where the CLI writes what a project's front end reads: the API address and the anon key, under
 * each framework's public prefix.
 *
 * They used to go to `.env` (init, Docker dev, `keys --write`) and `.env.local` (native dev). A
 * production build reads both, so `http://localhost:<port>` and the local stack's anon key shipped
 * in the bundle. A local stack's values now go to `.env.development.local`, which Vite, Next.js and
 * Expo read in development only (Expo: https://docs.expo.dev/guides/environment-variables/, where
 * `expo start` loads `.env.development.local` and `expo export` does not). A real deployment's
 * values go to `.env`, which a production build reads.
 */

import { LOCAL_HOSTS } from "./db-port.js"
import { readEnvFile, upsertEnvFile } from "./env-file.js"
import { info } from "./ui/messages.js"

/** Read in development only by Vite (and what is built on it), Next.js and Expo. Gitignored. */
export const DEV_FRONTEND_ENV_FILE = ".env.development.local"

/** Each framework's public prefix: Vite, SvelteKit and Astro (`PUBLIC_`), Next.js, Expo. */
const PREFIXES = ["VITE_", "PUBLIC_", "NEXT_PUBLIC_", "EXPO_PUBLIC_"] as const

/** The front end's names for the API address. */
export const FRONTEND_URL_KEYS: readonly string[] = PREFIXES.map((prefix) => `${prefix}SUPATYPE_URL`)

/** The front end's names for the anon key. */
export const FRONTEND_ANON_KEYS: readonly string[] = PREFIXES.map((prefix) => `${prefix}SUPATYPE_ANON_KEY`)

/** The files the CLI used to write a local stack's front-end values to. */
const FORMER_FILES = [".env", ".env.local"] as const

/** True for an address on this machine: one only a local stack answers at. */
export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * The API URL a project's `.env` records for its deployment: `PUBLIC_SUPATYPE_URL`, else
 * `API_EXTERNAL_URL`, or undefined.
 */
export function recordedApiUrl(env: Record<string, string>): string | undefined {
  return env["PUBLIC_SUPATYPE_URL"] || env["API_EXTERNAL_URL"] || undefined
}

/** What a front end is told: the API address, the anon key, or both. */
export interface FrontendValues {
  apiUrl?: string
  anonKey?: string
}

export interface WriteFrontendEnvOptions {
  /** False to fill only names the file lacks or leaves blank, as `keys --write` does without --force. */
  replace?: boolean
  /**
   * Whether the values are a local stack's. Read from `apiUrl` unless given. With no `apiUrl`,
   * nothing says which deployment an anon key is for, so it counts as a local stack's: in `.env` a
   * plain production build baked it (0.9.1 release test, S27).
   */
  local?: boolean
}

/** Each front-end name for the values given. */
export function frontendEnv(values: FrontendValues): Record<string, string> {
  const named = (keys: readonly string[], value: string | undefined) =>
    value === undefined ? [] : keys.map((key) => [key, value] as const)
  return Object.fromEntries([...named(FRONTEND_URL_KEYS, values.apiUrl), ...named(FRONTEND_ANON_KEYS, values.anonKey)])
}

/**
 * The server's own names for a local stack's values, which a Next.js app's `/supatype-env.js` route
 * and server client read: `next dev` loads {@link DEV_FRONTEND_ENV_FILE}, so the route answers in
 * development. Only ever written there, never to `.env`, where a production server sets its own.
 */
function localServerEnv(values: FrontendValues): Record<string, string> {
  return {
    ...(values.apiUrl !== undefined && { SUPATYPE_URL: values.apiUrl }),
    ...(values.anonKey !== undefined && { SUPATYPE_ANON_KEY: values.anonKey }),
  }
}

/**
 * Write the front end's names for `values` where a build of that kind reads them: a local stack's
 * to {@link DEV_FRONTEND_ENV_FILE} with the server's names beside them (localServerEnv), taking the
 * CLI's local copies out of `.env` and `.env.local`; anything else to `.env`. Returns the file
 * and the names written to it.
 */
export function writeFrontendEnv(
  dir: string,
  values: FrontendValues,
  options: WriteFrontendEnvOptions = {},
): { file: string; written: string[] } {
  const local = options.local ?? (values.apiUrl === undefined || isLocalUrl(values.apiUrl))
  const file = local ? DEV_FRONTEND_ENV_FILE : ".env"
  const current = readEnvFile(dir, file)
  const named = local ? { ...frontendEnv(values), ...localServerEnv(values) } : frontendEnv(values)
  const updates = Object.fromEntries(
    Object.entries(named).filter(([key]) => options.replace !== false || !current[key]?.trim()),
  )
  if (Object.keys(updates).length > 0) upsertEnvFile(dir, updates, { file })
  if (local) reportMoved(removeLocalCopies(dir, values))
  return { file, written: Object.keys(updates) }
}

/**
 * Take a local stack's front-end values out of `.env` and `.env.local`, for those being written
 * now: a URL naming this machine, which only the CLI's local stacks are, and the anon key given.
 * Anything else, a real deployment's address or key, is left as it is, and so is a URL when none
 * is written in its place (a port only the shell gave). Returns what was taken, with its file.
 */
function removeLocalCopies(dir: string, written: FrontendValues): string[] {
  const moved: string[] = []
  for (const file of FORMER_FILES) {
    const values = readEnvFile(dir, file)
    const stale = [
      ...FRONTEND_URL_KEYS.filter((key) => written.apiUrl !== undefined && isLocalUrl(values[key]?.trim() ?? "")),
      ...FRONTEND_ANON_KEYS.filter((key) => written.anonKey !== undefined && values[key]?.trim() === written.anonKey),
    ]
    if (stale.length === 0) continue
    upsertEnvFile(dir, {}, { file, remove: stale })
    moved.push(...stale.map((key) => `${key} (${file})`))
  }
  return moved
}

function reportMoved(moved: string[]): void {
  if (moved.length === 0) return
  info(`Moved ${moved.join(", ")} to ${DEV_FRONTEND_ENV_FILE}, so a production build does not ship the local stack's values.`)
}
