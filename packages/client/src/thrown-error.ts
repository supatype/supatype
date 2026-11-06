import { SupatypeError } from "./errors.js"

/**
 * A request a binding made that threw instead of answering `{ data, error }`, as the binding's
 * `error`, reported once with `console.error`.
 *
 * The client answers a refusal or a failed network call with `{ data, error }`, but some faults are
 * thrown on purpose: a client with no API address or anon key throws from its first request. A hook
 * that only awaited the request left its `loading` set for good and the rejection unhandled, so
 * every binding catches it and holds this as its `error` instead.
 *
 * The console line is the point: the error is usually a fault in the app's setup, and an app that
 * never reads `error` would otherwise show an empty page with no word of why. `where` names the
 * hook, so the line says which one.
 */
export function reportThrown(where: string, thrown: unknown): SupatypeError {
  console.error(`[supatype] ${where}: the request threw.`, thrown)
  return thrownAsError(thrown)
}

/**
 * The thrown value as a binding's `error`.
 *
 * One of the SDK's own errors is kept as it is, so `error instanceof` still names it, a setup fault
 * included. Anything else becomes a `SupatypeError` with its message, holding it as `cause`.
 */
function thrownAsError(thrown: unknown): SupatypeError {
  if (thrown instanceof SupatypeError) return thrown
  const message = thrown instanceof Error ? thrown.message : typeof thrown === "string" ? thrown : "Unknown error"
  return new SupatypeError({ message }, { cause: thrown })
}
