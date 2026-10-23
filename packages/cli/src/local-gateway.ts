import { readComposeEnvInt, readEnvValue } from "./env-file.js"

/**
 * Host port published for Kong in local Docker Compose. Kong still listens on
 * 8000 inside the container; this avoids clashing with other tools on :8000.
 */
export const LOCAL_KONG_HOST_PORT = 18473

export function localKongBaseUrl(): string {
  return `http://localhost:${LOCAL_KONG_HOST_PORT}`
}

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
  const port = readComposeEnvInt(cwd, "SUPATYPE_KONG_PORT") ?? LOCAL_KONG_HOST_PORT
  return `http://localhost:${port}`
}
