/**
 * A push's steps after the schema is applied (hooks, buckets) report a failure one way. The schema
 * is in by then, so each says that, says what did not happen and where, and how to finish; the push
 * ends non-zero and carries on with the steps after it, since none of them needs the one that failed.
 * The hooks used to stop the push there and the buckets to carry on, each with its own wording.
 */
import { error, plain } from "./ui/messages.js"

/** Says that the schema was applied but `what` (what did not happen, where, and why) was not. */
export function postApplyFailed(what: string, hint?: string): void {
  error(`The schema was applied, but ${what}`)
  if (hint !== undefined) plain(`  ${hint}`)
  plain("  Run `supatype push` again once that is fixed; the schema itself needs nothing more.")
  process.exitCode = 1
}
