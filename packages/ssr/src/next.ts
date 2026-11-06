/**
 * `/supatype-env.js` for a Next.js app: the route that gives a page the deployment's API address
 * and anon key when it loads, so one `next build` runs against any deployment.
 *
 * `next build` prerenders the static pages without the deployment's values, and the client then
 * reads them from `window.__SUPATYPE_ENV__` at its first request. This route sets that global from
 * `SUPATYPE_URL` and `SUPATYPE_ANON_KEY` as the running server has them, with the same body,
 * headers and misconfigured answer as the Supatype server's own `/supatype-env.js`. Put it at
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

/**
 * The deployment's values for the page; or the reason it is misconfigured, a fault to fix; or
 * switched off, as if there were no route.
 */
type PublicEnv = { url: string; anonKey: string } | { error: string } | "off"

/**
 * `GET /supatype-env.js`: the script setting `window.__SUPATYPE_ENV__`. Misconfigured, it is still
 * 200 and sets only `error`, the reason, because a browser runs no script answered with an error
 * status and tells the page nothing of why: this is the one way the client can name the fault on
 * its first call. Switched off it is 404, as the Supatype server answers.
 */
export function GET(): Response {
  const env = readPublicEnv()
  if (env === "off") return notFound()
  // A reason is kept by nothing, so the fixed configuration is read on the next load. Values are
  // revalidated on every load: they change when the deployment's configuration does.
  return script(env, "error" in env ? "no-store" : "no-cache")
}

/** The values to serve, read from the environment now, or why there are none. */
function readPublicEnv(): PublicEnv {
  const enabled = publicEnvSwitch(serverEnv(PUBLIC_ENV_SWITCH))
  if (enabled === false) return "off"
  // A word it cannot read is a fault to fix, not a choice to turn the route off.
  if (enabled !== true) return { error: enabled.invalid }
  // Both, or neither: a page given only the key fails at its first request for want of an address,
  // and the reason naming the variables says why, where the deployment is configured. Every fault
  // is named in one reason, one per line and the key's first, so a single visit fixes them all.
  const url = publicUrl(serverEnv(SERVER_URL_ENV))
  const anonKey = serverEnv(SERVER_ANON_KEY_ENV)
  const keyFault = anonKeyFault(anonKey)
  const urlFault = url === undefined ? notSet(SERVER_URL_ENV) : undefined
  if (url === undefined || anonKey === undefined || keyFault !== undefined) {
    const faults = [keyFault, urlFault].filter((fault): fault is string => fault !== undefined)
    return { error: faults.join("\n") }
  }
  return { url, anonKey }
}

/** Why the anon key variable cannot be served, or undefined when it can. */
function anonKeyFault(anonKey: string | undefined): string | undefined {
  if (anonKey === undefined) return notSet(SERVER_ANON_KEY_ENV)
  if (jwtClaims(anonKey)?.["role"] !== "service_role") return undefined
  return (
    `public env unavailable: ${SERVER_ANON_KEY_ENV} holds a service_role token, which must never ` +
    "reach a browser. Set it to the project's anon key."
  )
}

/** The reason line for a variable the server does not have, as the Supatype server words it. */
function notSet(name: string): string {
  return `public env unavailable: ${name} is not set on this server`
}

/**
 * `SUPATYPE_PUBLIC_ENV` as the server reads it: on when blank or 1, true, yes or on; off for 0, false,
 * no or off. Any other word stops the server from starting; here, with no start to stop, the route
 * is a reason naming the variable and the words it takes.
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

/** The statement setting `window.__SUPATYPE_ENV__` to `doc`, with the server's headers. */
function script(doc: object, cacheControl: "no-cache" | "no-store"): Response {
  const body = `${SCRIPT_GLOBAL} = ${escapeForScript(JSON.stringify(doc))};\n`
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  })
}

/** A 404 nothing keeps, so switching the route back on is seen at once, as the server answers. */
function notFound(): Response {
  return new Response("404 page not found\n", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
