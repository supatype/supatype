import { SupatypeError as SupatypeErrorClass, transportFailure } from "./errors.js"
import type { SupatypeError } from "./types.js"

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
 * An `Error` that already fits the shape is kept as it is, so `error instanceof` still names it and
 * its own fields stay readable. The SDK's error classes carry their status as `statusCode`, so they
 * get the same shape a request that failed in transit answers with.
 */
function thrownAsError(thrown: unknown): SupatypeError {
  if (thrown instanceof SupatypeErrorClass) return transportFailure(thrown)
  if (thrown instanceof Error && fitsErrorShape(thrown)) return thrown
  return { message: thrown instanceof Error ? thrown.message : typeof thrown === "string" ? thrown : "Unknown error" }
}

/** Whether every field `SupatypeError` names is absent or of its type, as on a plain `Error`. */
function fitsErrorShape(error: Error): error is Error & SupatypeError {
  const fields = new Map<string, unknown>(Object.entries(error))
  const textOrAbsent = (key: string): boolean => ["string", "undefined"].includes(typeof fields.get(key))
  return (
    ["code", "field", "hint", "details"].every(textOrAbsent) &&
    ["number", "undefined"].includes(typeof fields.get("status"))
  )
}
