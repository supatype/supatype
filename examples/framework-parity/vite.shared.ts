import { fileURLToPath } from "node:url"
import { loadEnv, type ProxyOptions, type UserConfig } from "vite"

/**
 * What the three app configs share: where the env lives, and how a dev or preview server reaches
 * the stack.
 *
 * Each app's `root` is its own `src/<framework>` directory, and Vite reads `.env` files from the
 * root unless told otherwise. `supatype keys` and `supatype dev` write the anon key next to
 * `supatype.config.ts`, so without `envDir` every build shipped an empty key.
 *
 * The shared client talks to `window.location.origin`, which is right when Supatype serves the
 * build (`mode:*`) and wrong on Vite's own port, where nothing answers `/auth/v1`. So the dev and
 * preview servers forward the API paths to the gateway, and the page stays on one origin either way.
 */
const exampleRoot = fileURLToPath(new URL(".", import.meta.url))

/** The API prefixes the client calls, all served by the gateway. */
const API_PATHS = ["/auth", "/rest", "/realtime", "/functions", "/storage", "/graphql"]

function gatewayUrl(mode: string): string {
  const env = loadEnv(mode, exampleRoot, "")
  const port = env["SUPATYPE_KONG_PORT"] ?? "18473"
  return env["VITE_SUPATYPE_URL"] ?? env["PUBLIC_SUPATYPE_URL"] ?? `http://127.0.0.1:${port}`
}

function apiProxy(target: string): Record<string, ProxyOptions> {
  return Object.fromEntries(API_PATHS.map((path) => [path, { target, changeOrigin: true, ws: true }]))
}

export function sharedConfig(mode: string): Pick<UserConfig, "envDir" | "server" | "preview"> {
  const proxy = apiProxy(gatewayUrl(mode))
  return { envDir: exampleRoot, server: { proxy }, preview: { proxy } }
}
