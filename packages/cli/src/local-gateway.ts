import { readComposeEnvInt, readEnvValue } from "./env-file.js"
import { COMPOSE_DEV_KONG_PORT, resolveRuntimeProvider, type SupatypeProjectConfig } from "./project-config.js"

/**
 * The local stack's public address, without a trailing slash: `.env`'s API_EXTERNAL_URL, the value
 * compose hands the server and the functions worker as their public address, else the gateway's
 * published port as compose binds it.
 *
 * For functions run on the host (`supatype functions serve`), whose `ctx.publicUrl` should be the
 * address the running stack answers on rather than the default port.
 */
export function localPublicApiUrl(cwd: string): string {
  const external = readEnvValue(cwd, "API_EXTERNAL_URL", "").replace(/\/+$/, "")
  if (external !== "") return external
  return `http://localhost:${composeKongHostPort(cwd)}`
}

/**
 * The host port the compose file publishes Kong on: SUPATYPE_KONG_PORT from the shell or `.env`,
 * else the default the compose file falls back to when it is unset. One definition for every
 * caller that needs the running stack's gateway rather than a port to give a new one.
 */
export function composeKongHostPort(cwd: string): number {
  return readComposeEnvInt(cwd, "SUPATYPE_KONG_PORT") ?? COMPOSE_DEV_KONG_PORT
}

/** What `link`'s field is called: the server's URL for native dev, which has no gateway (local test 3b). */
export function localLinkLabel(config: SupatypeProjectConfig): string {
  return resolveRuntimeProvider(config) === "native" ? "Server URL" : "Kong gateway URL"
}
