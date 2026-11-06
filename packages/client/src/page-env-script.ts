/**
 * The page's `<script src=".../supatype-env.js">` element, when it has one.
 *
 * A page that has the element and still no `window.__SUPATYPE_ENV__` did not run the script: it was
 * blocked, failed to load, ran after the app's own script, or came from a server too old to serve
 * it. A misconfigured server still answers 200 with a script setting `error`, so a missing global
 * never means the server refused. The error a request throws then says the script is there and to
 * open it, not to add it.
 */

/** The absolute address of the page's `/supatype-env.js` script, or undefined when it has none. */
export function pageEnvScript(): string | undefined {
  if (typeof document === "undefined") return undefined
  for (const script of Array.from(document.scripts)) {
    if (isEnvScript(script.src)) return script.src
  }
  return undefined
}

function isEnvScript(src: string): boolean {
  if (src === "") return false
  try {
    return new URL(src).pathname.endsWith("/supatype-env.js")
  } catch {
    return false
  }
}
