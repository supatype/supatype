/**
 * The project's local API address, for every CLI command that calls it and for what `link` offers.
 *
 * By provider, and by who wrote the value. `SUPATYPE_URL` and `SUPATYPE_API_URL` are never written by
 * the CLI, so one in `.env` is the developer's and wins for either provider. The gateway keys below
 * are what Docker dev and `init` write, so a native project with a Docker run behind it holds a
 * gateway address where nothing runs: native dev has no gateway, and its API is the server, on
 * `server.port`. Read first, they sent `functions invoke --local`, the REST cache admin and
 * `functions serve`'s `ctx.publicUrl` there (local test round 3b).
 *
 * `SITE_URL` is not read: it is the app's address, where auth emails send people, and a fresh init's
 * `http://localhost:3000` was read as the API's.
 */

import { loadConfig, rethrowIfConfigBroken } from "./config.js"
import { readComposeEnvInt, readEnvValue } from "./env-file.js"
import {
  COMPOSE_DEV_KONG_PORT,
  NATIVE_SERVER_PORT,
  resolveRuntimeProvider,
  serverBaseUrl,
  type SupatypeProjectConfig,
} from "./project-config.js"

/** URL keys only a developer sets; the CLI writes none of them. */
const DEVELOPER_URL_KEYS = ["SUPATYPE_URL", "SUPATYPE_API_URL"] as const

/** URL keys `init`, Docker dev and `keys --write` write, naming the gateway. */
const GATEWAY_URL_KEYS = ["PUBLIC_SUPATYPE_URL", "NEXT_PUBLIC_SUPATYPE_URL", "API_EXTERNAL_URL"] as const

/** The project's config as far as it could be read: loaded, absent, or broken with why. */
type ConfigRead = { config: SupatypeProjectConfig } | { config: undefined; broken?: unknown }

/**
 * Kong or server origin without a trailing slash. Pass the project's `config` when it is loaded
 * already; otherwise it is read here, and only when `.env` does not answer first.
 */
export function resolveProjectApiUrl(cwd: string, config?: SupatypeProjectConfig): string {
  return projectApiUrl(cwd, config).replace(/\/+$/, "")
}

function projectApiUrl(cwd: string, given: SupatypeProjectConfig | undefined): string {
  const developer = firstEnvUrl(cwd, DEVELOPER_URL_KEYS)
  if (developer !== undefined) return developer
  const read: ConfigRead = given !== undefined ? { config: given } : readConfig(cwd)
  if (read.config !== undefined && resolveRuntimeProvider(read.config) === "native") {
    return serverBaseUrl(read.config, cwd) ?? `http://localhost:${NATIVE_SERVER_PORT}`
  }
  const gateway = gatewayFromEnv(cwd)
  if (gateway !== undefined) return gateway
  if ("broken" in read) throw read.broken
  return defaultApiUrl(cwd, read.config)
}

/** The project's config, absent outside a project, or the reason it is broken, kept for later. */
function readConfig(cwd: string): ConfigRead {
  try {
    return { config: loadConfig(cwd) }
  } catch (err) {
    try {
      rethrowIfConfigBroken(err)
    } catch (broken) {
      return { config: undefined, broken }
    }
    return { config: undefined }
  }
}

/** The first of `keys` `.env` names, if any. */
function firstEnvUrl(cwd: string, keys: readonly string[]): string | undefined {
  return keys.map((key) => readEnvValue(cwd, key, "").trim()).find((value) => value !== "")
}

/** The gateway's address as `.env` records it: a URL Docker dev wrote, else its port as compose binds it. */
function gatewayFromEnv(cwd: string): string | undefined {
  const named = firstEnvUrl(cwd, GATEWAY_URL_KEYS)
  if (named !== undefined) return named
  const kongPort = readComposeEnvInt(cwd, "SUPATYPE_KONG_PORT")
  return kongPort === null ? undefined : `http://localhost:${kongPort}`
}

/**
 * Nothing recorded yet. A Docker project's gateway is on the port compose binds by default, or its
 * domain in production; never the native server's port. Outside a project, `PORT`, then the
 * native server's default.
 */
function defaultApiUrl(cwd: string, config: SupatypeProjectConfig | undefined): string {
  if (config !== undefined) {
    return config.server.domain ? `https://${config.server.domain}` : `http://localhost:${COMPOSE_DEV_KONG_PORT}`
  }
  const port = String(NATIVE_SERVER_PORT)
  return `http://localhost:${readEnvValue(cwd, "PORT", port).trim() || port}`
}
