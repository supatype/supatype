/**
 * Strict mode: a degraded path is a failure rather than a warning.
 *
 * Every fallback in this CLI exists because giving up would serve a person at a terminal worse
 * than carrying on: the in-compose engine when the CDN cannot be reached, SHA256-only verification
 * when no key is embedded, a bucket that could not be reached from the host but works from inside
 * the network. Each is the right default interactively.
 *
 * In CI the trade runs the other way. A run that limps reports success, and the thing it quietly
 * skipped is precisely the thing nobody tests again.
 *
 * This is not hypothetical. On 2026-09-24 three integration jobs failed on assertions about
 * validators and served SPAs, and the cause in all three was an engine download refused twenty
 * lines earlier and warned about. The same fallback made a local from-zero run look like a clean
 * pass while the host engine path was never exercised at all.
 */

/** True when the caller has asked for degraded paths to fail. */
export function strict(): boolean {
  return process.env["SUPATYPE_STRICT"] === "1"
}

/**
 * Report a path that worked less well than intended.
 *
 * Throws under `SUPATYPE_STRICT=1`, so a CI job cannot pass over it. Warns otherwise, because
 * interactively a working stack and a note beats an abort.
 *
 * `what` names the capability that degraded, not the error: the reader needs to know which feature
 * they are now without. `detail` carries the cause.
 */
export function degraded(what: string, detail: string): void {
  const message = `${what}: ${detail}`
  if (strict()) {
    throw new Error(
      `${message}\nSUPATYPE_STRICT=1 is set, so a degraded path fails rather than warns.`,
    )
  }
  console.warn(`[supatype] ${message}`)
}
