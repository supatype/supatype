/**
 * The setup fault a client with no address or anon key reports, and the one rule for it.
 *
 * Kept out of errors.ts, which the main entry re-exports whole: `MissingClientValuesError` is public
 * (index.ts exports it by name, so an app can catch it), and `rethrowSetupFault` is not.
 */

/** The two values a client cannot send a request without. */
export type ClientValue = "url" | "anonKey"

/**
 * A request made by a client that has no API address or no anon key.
 *
 * Thrown by the request, never by `createClient`: a client created at module scope runs while a
 * framework prerenders a page, which sends nothing and needs neither. It is a setup fault rather
 * than an answer from the server, so no request turns it into `{ data: null, error }`
 * (transportFailure rethrows it): an app that only reads `data` would show an empty page instead.
 */
export class MissingClientValuesError extends Error {
  /** Which of the two values were still missing when the request was made. */
  readonly missing: readonly ClientValue[]

  constructor(message: string, missing: readonly ClientValue[]) {
    super(message)
    this.name = "MissingClientValuesError"
    this.missing = missing
  }
}

/**
 * Throw `e` again when it is a setup fault (a client with no address or anon key). Every catch-all
 * on a request path calls this first, so none can turn that error into a result or a sign-out.
 */
export function rethrowSetupFault(e: unknown): void {
  if (e instanceof MissingClientValuesError) throw e
}
