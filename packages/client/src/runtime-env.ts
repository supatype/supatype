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
 * Nothing is checked when the client is created. `next build` prerenders every static page, so a
 * client created at module scope runs during the build, which has neither value and sends nothing.
 * The first request is what needs them: it reads the page again at that moment, since the script
 * may load after the module that created the client, and throws naming whatever is still missing.
 * That read happens at run time, so a bundler that replaced both names with `undefined` cannot fold
 * it away, as it could an app's own `if (!key) throw`. No address is ever guessed from the page.
 */

import { MissingClientValuesError, type ClientValue } from "./setup-fault.js"
import { objectOrEmpty } from "./json.js"
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

/** An absolute http or https address, else undefined. */
function httpUrl(value: unknown): string | undefined {
  const text = present(value)
  if (text === undefined) return undefined
  try {
    const protocol = new URL(text).protocol
    return protocol === "http:" || protocol === "https:" ? text : undefined
  } catch {
    return undefined
  }
}

/** The page's `__SUPATYPE_ENV__` fields, each still unchecked; none when it is not an object. */
function pageEnv(): { url: unknown; anonKey: unknown } {
  const env = objectOrEmpty(globalThis.__SUPATYPE_ENV__)
  return { url: env["url"], anonKey: env["anonKey"] }
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

/** In a page: the page set no `__SUPATYPE_ENV__`, so the script that sets it comes first. */
function pageMessage(n: MissingNames): string {
  return (
    `Supatype client has no ${n.labels}. createClient was given none, and the page had set no ` +
    `window.__SUPATYPE_ENV__ by its first request.\n` +
    `When Supatype hosts the app, add <script src="/supatype-env.js"></script> to index.html before ` +
    `the app's own script, and the server fills them in when the page loads. In a Next.js app, ` +
    `export GET from @supatype/ssr/next in app/supatype-env.js/route.ts, load it in the root layout ` +
    `with <Script src="/supatype-env.js" strategy="beforeInteractive" />, and set ${n.serverNames} ` +
    `in the server's environment.\n${buildTimeFix(n)}`
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

/** The error for the values still missing, naming each one's every name and every fix. */
function missingClientValuesError(missing: readonly ClientValue[]): MissingClientValuesError {
  const names: MissingNames = {
    labels: missing.map((key) => MISSING_VALUES[key].label).join(" and "),
    buildNames: missing.flatMap((key) => FRONTEND_PREFIXES.map((prefix) => `${prefix}${MISSING_VALUES[key].name}`)).join(", "),
    serverNames: missing.map((key) => MISSING_VALUES[key].name).join(" and "),
    pronoun: missing.length > 1 ? "them" : "it",
  }
  // Read when the error is made, as the page is: a bundler cannot know which side it runs on.
  const onServer = typeof window === "undefined"
  return new MissingClientValuesError(onServer ? serverMessage(names) : pageMessage(names), missing)
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
    this.#url = present(given.url)
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
