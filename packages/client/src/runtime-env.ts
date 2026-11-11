/**
 * The address and anon key a client runs with, when the build did not carry them.
 *
 * A server that hosts the app answers `GET /supatype-env.js` with
 *
 *     window.__SUPATYPE_ENV__ = { url: "https://api.example.com", anonKey: "..." }
 *
 * and the page loads it before its own code: a classic `<script>` in a static app's head, or, in a
 * Next.js app, the route `@supatype/ssr/next` exports, loaded by the root layout. One build then
 * works for every deployment that serves it. A value the build did carry always wins.
 *
 * A server that cannot give the values still answers 200, with `{ error: "<why>" }` in their place:
 * a browser runs no script answered with an error status, and tells the page nothing of why. The
 * first request quotes that reason, with no request of its own.
 *
 * Nothing is checked when the client is created. `next build` prerenders every static page, so a
 * client created at module scope runs during the build, which has neither value and sends nothing.
 * The first request is what needs them: it reads the page again at that moment, since the script
 * may load after the module that created the client, and throws naming whatever is still missing.
 * That read happens at run time, so a bundler that replaced both names with `undefined` cannot fold
 * it away, as it could an app's own `if (!key) throw`. No address is ever guessed from the page.
 */

import { MissingClientValuesError, type ClientValue } from "./setup-fault.js"
import { objectOrEmpty } from "./json.js"
import { pageEnvScript } from "./page-env-script.js"
import type { SupatypeClientConfig } from "./types.js"

declare global {
  /**
   * Set by `<script src="/supatype-env.js">`. Typed `unknown` because nothing at compile time knows
   * what the page holds; each field is checked before use.
   */
  var __SUPATYPE_ENV__: unknown
}

/** The two values every request needs, once each has been found. */
interface ResolvedClientTarget {
  url: string
  anonKey: string
}

/**
 * A value, or a function that reads it when a request needs it. The sub-clients take either, so
 * `createClient` can hand them an address it does not know yet.
 */
export type Deferred<T extends string | Record<string, string>> = T | (() => T)

/** The value now: a plain one as it is, a deferred one read. */
export function settle<T extends string | Record<string, string>>(value: Deferred<T>): T {
  return typeof value === "function" ? value() : value
}

/**
 * Each framework's public prefix: Vite, SvelteKit and Astro (`PUBLIC_`), Next.js, Expo. The same
 * list as the CLI's `frontend-env.ts`, which writes these names; this package cannot import it.
 */
const FRONTEND_PREFIXES = ["VITE_", "PUBLIC_", "NEXT_PUBLIC_", "EXPO_PUBLIC_"] as const

const MISSING_VALUES = {
  url: { label: "API address", name: "SUPATYPE_URL" },
  anonKey: { label: "anon key", name: "SUPATYPE_ANON_KEY" },
} as const

/** A non-empty string, else undefined: what a bundler leaves for an unset name is either. */
function present(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

/**
 * `url` without the "/" it may end in. Every path is joined on as `${url}/rest/v1/...`, and
 * `https://api.example.com/` built `//rest/v1/...`, which the gateway refuses as a path with an
 * empty part (0.9.1 release test RB2) and the server on native never routed to an API.
 */
function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "")
}

/** An absolute http or https address, else undefined. */
function httpUrl(value: unknown): string | undefined {
  const text = present(value)
  if (text === undefined) return undefined
  try {
    const protocol = new URL(text).protocol
    return protocol === "http:" || protocol === "https:" ? withoutTrailingSlash(text) : undefined
  } catch {
    return undefined
  }
}

/** The page's `__SUPATYPE_ENV__` fields, each still unchecked; none when it is not an object. */
function pageEnv(): { url: unknown; anonKey: unknown; error: unknown } {
  const env = objectOrEmpty(globalThis.__SUPATYPE_ENV__)
  return { url: env["url"], anonKey: env["anonKey"], error: env["error"] }
}

/** What the error says, for the values still missing, by whichever name each is set under. */
interface MissingNames {
  labels: string
  buildNames: string
  serverNames: string
  pronoun: "it" | "them"
}

/** The build-time names and the fix that fills them, which both kinds of the error end with. */
function buildTimeFix(n: MissingNames): string {
  return (
    `Or set ${n.pronoun} at build time under the name your framework reads: ${n.buildNames}. Building ` +
    `with \`supatype build -- <your build command>\` fills them from your deployment.`
  )
}

/** The opening every page-side message without the global shares. */
function noPageGlobal(n: MissingNames): string {
  return (
    `Supatype client has no ${n.labels}. createClient was given none, and the page had set no ` +
    `window.__SUPATYPE_ENV__ by its first request.\n`
  )
}

/** In a page: the page set no `__SUPATYPE_ENV__`, so the script that sets it comes first. */
function pageMessage(n: MissingNames): string {
  return (
    noPageGlobal(n) +
    `When Supatype hosts the app, add <script src="/supatype-env.js" vite-ignore></script> to index.html before ` +
    `the app's own script, and the server fills them in when the page loads. In a Next.js app, ` +
    `export GET from @supatype/ssr/next in app/supatype-env.js/route.ts, load it in the root layout ` +
    `with <Script src="/supatype-env.js" strategy="beforeInteractive" />, and set ${n.serverNames} ` +
    `in the server's environment.\n${buildTimeFix(n)}`
  )
}

/**
 * Whether this runs in an Expo app. Expo's runtime sets `globalThis.expo`, on the web as on a phone.
 * The app's own code reads the `EXPO_PUBLIC_` names, so which names were tried is not something the
 * client can see; the global is the one sign it has.
 */
function isExpoApp(): boolean {
  const expo: unknown = Reflect.get(globalThis, "expo")
  return typeof expo === "object" && expo !== null
}

/**
 * In an Expo app: the page comes from `app/+html.tsx`, not an `index.html` (0.9.2 release test,
 * N-S14), and a native build has no page at all.
 */
function expoPageMessage(n: MissingNames): string {
  return (
    noPageGlobal(n) +
    `On the web, when Supatype hosts the export, add <script src="/supatype-env.js" /> to the <head> of ` +
    `app/+html.tsx (src/app/+html.tsx when the routes are in src/app), and the server fills them in when ` +
    `the page loads; supatype init adds it to an Expo Router app. A native build has no page to read ` +
    `them from, so it takes them at build time.\n${buildTimeFix(n)}`
  )
}

/** On a server there is no page: its own variables are what to set. */
function serverMessage(n: MissingNames): string {
  return (
    `Supatype client has no ${n.labels}. It was given none, and it is running on a server, where ` +
    `there is no page to read them from.\n` +
    `Set ${n.serverNames} in the server's environment: createServerClient from @supatype/ssr reads ` +
    `them when it is not given them, and @supatype/ssr/next serves them to the browser from ` +
    `app/supatype-env.js/route.ts.\n${buildTimeFix(n)}`
  )
}

/** The servers that answer `/supatype-env.js`, where its values or its reason come from. */
const SCRIPT_SERVERS =
  "the Supatype server, or in a Next.js app the server running the route app/supatype-env.js/route.ts " +
  "exports from @supatype/ssr/next"

/** In a page whose script set the server's reason in place of the values: that reason is the fix. */
function reasonMessage(n: MissingNames, script: string, reason: string): string {
  return (
    `Supatype client has no ${n.labels}. createClient was given none, and ${script} set no ${n.labels}, ` +
    `giving the server's reason instead:\n${reason}\n` +
    `Fix that in the environment of the server that answers it (${SCRIPT_SERVERS}), then reload the ` +
    `page.\n${buildTimeFix(n)}`
  )
}

/** In a page that has the script element and no global: the script is there, and did not run. */
function scriptDidNotRunMessage(n: MissingNames, script: string): string {
  return (
    `Supatype client has no ${n.labels}. createClient was given none, and the page loads ${script}, ` +
    `but it had set no window.__SUPATYPE_ENV__ by the page's first request. The script did not run in ` +
    `time: it was blocked, failed to load, ran after the app's own script, or came from a server too ` +
    `old to serve it.\nOpen ${script} in the browser: it should set window.__SUPATYPE_ENV__. When it ` +
    `does, load it before the app's own script, without async or defer. When it does not, update the ` +
    `server that answers it (${SCRIPT_SERVERS}).\n${buildTimeFix(n)}`
  )
}

/** In a page: the script's reason when it set one, else whether the page has the script at all. */
function pageFaultMessage(n: MissingNames): string {
  const script = pageEnvScript()
  const reason = present(pageEnv().error)
  if (reason !== undefined) return reasonMessage(n, script ?? "/supatype-env.js", reason)
  if (script !== undefined) return scriptDidNotRunMessage(n, script)
  return isExpoApp() ? expoPageMessage(n) : pageMessage(n)
}

/** Each missing value's label and every name it is set under, as the error words them. */
function missingNames(missing: readonly ClientValue[]): MissingNames {
  return {
    labels: missing.map((key) => MISSING_VALUES[key].label).join(" and "),
    buildNames: missing.flatMap((key) => FRONTEND_PREFIXES.map((prefix) => `${prefix}${MISSING_VALUES[key].name}`)).join(", "),
    serverNames: missing.map((key) => MISSING_VALUES[key].name).join(" and "),
    pronoun: missing.length > 1 ? "them" : "it",
  }
}

/** The error for the values still missing, naming each one's every name and every fix. */
function missingClientValuesError(missing: readonly ClientValue[]): MissingClientValuesError {
  const names = missingNames(missing)
  // Read when the error is made, as the page is: a bundler cannot know which side it runs on.
  const onServer = typeof window === "undefined"
  return new MissingClientValuesError(onServer ? serverMessage(names) : pageFaultMessage(names), missing)
}

/**
 * Where one client sends its requests, found when the first one is made.
 *
 * Each value is the one given, else the page's `__SUPATYPE_ENV__` as it is when a request asks.
 * A value once found is kept, so every request after it goes to the same place, and the page is
 * not read again once both are known.
 */
export class ClientTarget {
  #url: string | undefined
  #anonKey: string | undefined
  #resolved: ResolvedClientTarget | undefined

  constructor(given: Pick<SupatypeClientConfig, "url" | "anonKey">) {
    const url = present(given.url)
    this.#url = url === undefined ? undefined : withoutTrailingSlash(url)
    this.#anonKey = present(given.anonKey)
  }

  /** Both values, reading the page for any not found yet. Throws naming whatever is still missing. */
  resolve(): ResolvedClientTarget {
    if (this.#resolved !== undefined) return this.#resolved
    const url = this.#findUrl()
    this.#anonKey ??= present(pageEnv().anonKey)
    if (url !== undefined && this.#anonKey !== undefined) return (this.#resolved = { url, anonKey: this.#anonKey })
    const missing: ClientValue[] = []
    if (url === undefined) missing.push("url")
    if (this.#anonKey === undefined) missing.push("anonKey")
    throw missingClientValuesError(missing)
  }

  /** The address if it can be found now, else an empty string. Never throws. */
  currentUrl(): string {
    return this.#findUrl() ?? ""
  }

  /** The address as given or as the page has set it, kept once found. */
  #findUrl(): string | undefined {
    this.#url ??= httpUrl(pageEnv().url)
    return this.#url
  }
}
