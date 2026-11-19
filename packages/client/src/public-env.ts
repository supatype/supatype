/**
 * One of the site's own public values, read at page load.
 *
 * `/supatype-env.js` sets `window.__SUPATYPE_ENV__ = { url, anonKey, env: { NAME: "value" } }`, and
 * the names under `env` are the ones set in `build.publicEnv` of `supatype.config.ts` or in Studio's
 * Static site settings. They are not secret: every visitor can read them.
 *
 * The page is read on each call, not when the module loads, because the script may load after the
 * module that asks. A value the script did not set, or a page whose script has not run, is undefined.
 */

import { isJsonObject } from "./json.js"

/** The value of public value `name`, or undefined when the page has no such value. */
export function publicEnv(name: string): string | undefined {
  const page = globalThis.__SUPATYPE_ENV__
  if (!isJsonObject(page)) return undefined
  const values = page["env"]
  if (!isJsonObject(values) || !Object.hasOwn(values, name)) return undefined
  const value = values[name]
  return typeof value === "string" ? value : undefined
}
