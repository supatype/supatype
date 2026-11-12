import { readComposeEnvInt, readEnvValue } from "./env-file.js"
import { COMPOSE_DEV_KONG_PORT, resolveRuntimeProvider, type SupatypeProjectConfig } from "./project-config.js"

/**
 * The local stack's public address, without a trailing slash: API_EXTERNAL_URL as compose hands it
 * to the server and the functions worker as their public address (exported first, then `.env`),
 * else the gateway's published port as compose binds it.
 *
 * For functions run on the host (`supatype functions serve`), whose `ctx.publicUrl` should be the
 * address the running stack answers on rather than the default port.
 */
export function localPublicApiUrl(cwd: string): string {
  const exported = process.env["API_EXTERNAL_URL"]?.trim() ?? ""
  const external = (exported !== "" ? exported : readEnvValue(cwd, "API_EXTERNAL_URL", "")).replace(/\/+$/, "")
  if (external !== "") return external
  return `http://localhost:${composeKongHostPort(cwd)}`
}

/**
 * The host port the compose file publishes Kong on: SUPATYPE_KONG_PORT from the environment or
 * `.env`, as compose reads it, else the default the compose file falls back to when it is unset.
 * One definition for every caller that needs the running stack's gateway rather than a port to give
 * a new one. A port the shell gave dev is kept out of .env (0.9.2 round 2, R2-S17): every path to
 * the local stack enters it first (`enterLocalStack`), which puts the session's port in the environment.
 */
export function composeKongHostPort(cwd: string): number {
  return readComposeEnvInt(cwd, "SUPATYPE_KONG_PORT") ?? COMPOSE_DEV_KONG_PORT
}

/** What `link`'s field is called: the server's URL for native dev, which has no gateway (local test 3b). */
export function localLinkLabel(config: SupatypeProjectConfig): string {
  return resolveRuntimeProvider(config) === "native" ? "Server URL" : "Kong gateway URL"
}
