/**
 * `/supatype-env.js` for a Next.js app: the route that gives a page the deployment's API address
 * and anon key when it loads, so one `next build` runs against any deployment.
 *
 * `next build` prerenders the static pages without the deployment's values, and the client then
 * reads them from `window.__SUPATYPE_ENV__` at its first request. This route sets that global from
 * `SUPATYPE_URL` and `SUPATYPE_ANON_KEY` as the running server has them, with the same body,
 * headers and refusals as the Supatype server's own `/supatype-env.js`. Put it at
 * `app/supatype-env.js/route.ts`:
 *
 *     export { GET } from "@supatype/ssr/next"
 *     export const dynamic = "force-dynamic"
 *
 * The `dynamic` line is written in the route file itself: Next's build reads a route's segment
 * config from that file's own source, and warns that it cannot recognize a re-exported one and
 * uses the default instead. Next 15 already renders a `GET` handler per request by default; Next 14
 * prerendered one, which would bake the build machine's values into a static file. Then load it
 * before the app in the root layout:
 *
 *     <Script src="/supatype-env.js" strategy="beforeInteractive" />
 *
 * The anon key is not a secret: every browser that loads the app holds it, and row-level security
 * protects the data. The service role key is never read here, and an anon key variable holding a
 * service role token is refused rather than published.
 */

import { jwtClaims } from "./jwt-claims.js"
import { SERVER_ANON_KEY_ENV, SERVER_URL_ENV, serverEnv } from "./server-env.js"

/** Never prerendered. Exported for tests and tools; the route file writes its own (see above). */
export const dynamic = "force-dynamic"

const PUBLIC_ENV_SWITCH = "SUPATYPE_PUBLIC_ENV"
const SCRIPT_GLOBAL = "window.__SUPATYPE_ENV__"

/** `<`, `>`, `&` and the two JavaScript line separators, escaped in the body as Go's JSON does. */
const SCRIPT_UNSAFE = new Set([0x3c, 0x3e, 0x26, 0x2028, 0x2029])

/** The deployment's values for the page, or why there are none to give. */
type PublicEnv = { url: string; anonKey: string } | { refusal: string; status: RefusalStatus }

/**
 * 404 when the route is switched off, as if there were none; 503 when it is on but the deployment
 * is misconfigured, a fault to fix rather than an absence, as the Supatype server answers.
 */
type RefusalStatus = 404 | 503

/** `GET /supatype-env.js`: the script setting `window.__SUPATYPE_ENV__`, or why there is none. */
export function GET(): Response {
  const env = readPublicEnv()
  if ("refusal" in env) return refuse(env.refusal, env.status)
  const doc = { url: env.url, anonKey: env.anonKey }
  const body = `${SCRIPT_GLOBAL} = ${escapeForScript(JSON.stringify(doc))};\n`
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Revalidated on every load: the values change when the deployment's configuration does.
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

/** The values to serve, read from the environment now, or the refusal the server would give. */
function readPublicEnv(): PublicEnv {
  const enabled = publicEnvSwitch(serverEnv(PUBLIC_ENV_SWITCH))
  if (enabled === false) return { refusal: "404 page not found", status: 404 }
  // A word it cannot read is a fault to fix, not a choice to turn the route off.
  if (enabled !== true) return { refusal: enabled.invalid, status: 503 }
  // Both, or neither: a page given only the key fails at its first request for want of an address,
  // and a 503 naming the variable says why, where the deployment is configured.
  const url = publicUrl(serverEnv(SERVER_URL_ENV))
  const anonKey = serverEnv(SERVER_ANON_KEY_ENV)
  if (anonKey === undefined) return notSet(SERVER_ANON_KEY_ENV)
  if (url === undefined) return notSet(SERVER_URL_ENV)
  if (jwtClaims(anonKey)?.["role"] === "service_role") {
    return {
      refusal:
        `public env unavailable: ${SERVER_ANON_KEY_ENV} holds a service_role token, which must never ` +
        "reach a browser. Set it to the project's anon key.",
      status: 503,
    }
  }
  return { url, anonKey }
}

/** The refusal for a variable the server does not have, as the Supatype server words it. */
function notSet(name: string): PublicEnv {
  return { refusal: `public env unavailable: ${name} is not set on this server`, status: 503 }
}

/**
 * `SUPATYPE_PUBLIC_ENV` as the server reads it: on when blank or 1, true, yes or on; off for 0, false,
 * no or off. Any other word stops the server from starting; here, with no start to stop, the route
 * is 503 naming the variable and the words it takes.
 */
function publicEnvSwitch(raw: string | undefined): boolean | { invalid: string } {
  const value = (raw ?? "").toLowerCase()
  if (["", "1", "true", "yes", "on"].includes(value)) return true
  if (["0", "false", "no", "off"].includes(value)) return false
  return {
    invalid:
      `public env unavailable: ${PUBLIC_ENV_SWITCH}=${JSON.stringify(raw)} is not a switch value. Use ` +
      "true, 1, yes or on (or leave it blank) to serve it, and false, 0, no or off to turn it off.",
  }
}

/** The API root, as the server gives it: no trailing slash, no auth service mount. */
function publicUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.replace(/\/+$/, "").replace(/\/auth\/v1$/, "")
  return trimmed === undefined || trimmed === "" ? undefined : trimmed
}

/** JSON that cannot close the script element or end the statement early. */
function escapeForScript(json: string): string {
  let out = ""
  for (const ch of json) {
    const code = ch.codePointAt(0) ?? 0
    out += SCRIPT_UNSAFE.has(code) ? `\\u${code.toString(16).padStart(4, "0")}` : ch
  }
  return out
}

/** A refusal nothing keeps, so the next configuration change is seen at once, as the server answers. */
function refuse(message: string, status: RefusalStatus): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
