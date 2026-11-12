import { fileURLToPath } from "node:url"
import { loadEnv, type ProxyOptions, type UserConfig } from "vite"

/**
 * What the three app configs share: where the env lives, and how a dev or preview server reaches
 * the stack.
 *
 * Each app's `root` is its own `src/<framework>` directory, and Vite reads `.env` files from the
 * root unless told otherwise. `supatype keys` and `supatype dev` write the local stack's values
 * to `.env.development.local` next to `supatype.config.ts`, which only the dev server reads.
 *
 * The shared client talks to `window.location.origin`, which is right when Supatype serves the
 * build (`mode:*`) and wrong on Vite's own port, where nothing answers `/auth/v1`. So the dev and
 * preview servers forward the API paths to the gateway, and the page stays on one origin either way.
 * `/supatype-env.js` goes the same way: a production build carries no anon key, and the page reads
 * it from that script, which only the gateway answers.
 */
const exampleRoot = fileURLToPath(new URL(".", import.meta.url))

/** The paths the page calls, all served by the gateway: the API, and the script naming its key. */
const API_PATHS = ["/auth", "/rest", "/realtime", "/functions", "/storage", "/graphql", "/supatype-env.js"]

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
