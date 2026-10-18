/**
 * Which `message` events `useLivePreview` believes.
 *
 * A preview message repaints the page with whatever it carries, so it is only applied when Studio
 * sent it. Two checks, taken from the two editors that solved this first:
 *
 *   - The sender's origin is compared exactly with the origins Studio is served from, as Payload's
 *     live preview compares `event.origin` with its `serverURL`.
 *   - The sending window must be the one this page is framed by, as Sanity's comlink pins the one
 *     window it handshook with. Studio's pane is that parent; any other window is not Studio.
 *
 * Studio is served at `/studio/` on the project's API URL, so the client's URL names its origin
 * unless the app says otherwise. With neither, nothing is trusted: an unknown sender is never one.
 */
import { originOf } from "@supatype/client/bindings"

/** One URL or origin, or several, that Studio may post previews from. */
export type StudioOrigins = string | readonly string[]

/** A space cannot appear in a URL, so it cannot split one. */
const URL_SEPARATOR = " "

/**
 * The URLs Studio may post from, as one string: the ones `configured` names, else the client URL.
 *
 * A string so a hook can depend on it: a caller's inline array is a new array every render, and the
 * listener should be replaced only when the URLs themselves change.
 */
export function studioUrlsKey(configured: StudioOrigins | undefined, clientUrl: string | undefined): string {
  const urls = configured ?? clientUrl ?? []
  return typeof urls === "string" ? urls : urls.join(URL_SEPARATOR)
}

/** The exact origins a `studioUrlsKey` names; an entry that is not an absolute URL names none. */
export function trustedStudioOrigins(urlsKey: string): ReadonlySet<string> {
  return new Set(urlsKey.split(URL_SEPARATOR).map((url) => originOf(url)).filter((origin) => origin !== null))
}

/**
 * Say, once per origin, that a preview from `origin` was refused.
 *
 * A Studio served somewhere other than the client's URL is a configuration a developer has to make,
 * and without this the only symptom is a preview that never updates.
 */
export function warnRefusedOrigin(origin: string, warned: Set<string>): void {
  if (warned.has(origin)) return
  warned.add(origin)
  console.warn(
    `[supatype] useLivePreview ignored a live preview message from ${origin}, which is not a trusted ` +
      "Studio origin. If Studio is served from there, pass it as `studioOrigin`.",
  )
}
