/**
 * The one rule for a setup fault: a client with no address or anon key.
 *
 * `MissingClientValuesError` lives in errors.ts with the rest of the error family, which the main
 * entry re-exports whole; `rethrowSetupFault` is kept here because it is not public.
 */

import { MissingClientValuesError } from "./errors.js"

export { MissingClientValuesError, type ClientValue } from "./errors.js"

/**
 * Throw `e` again when it is a setup fault (a client with no address or anon key). Every catch-all
 * on a request path calls this first, so none can turn that error into a result or a sign-out.
 */
export function rethrowSetupFault(e: unknown): void {
  if (e instanceof MissingClientValuesError) throw e
}
