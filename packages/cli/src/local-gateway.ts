import { readComposeEnvInt, readEnvValue } from "./env-file.js"
import { COMPOSE_DEV_KONG_PORT } from "./project-config.js"

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
  // The port compose binds when SUPATYPE_KONG_PORT is unset: one definition with every other caller.
  const port = readComposeEnvInt(cwd, "SUPATYPE_KONG_PORT") ?? COMPOSE_DEV_KONG_PORT
  return `http://localhost:${port}`
}
