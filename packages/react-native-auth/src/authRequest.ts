import type { SupatypeError } from "@supatype/client"
import { reportThrown } from "@supatype/client/bindings"

/** A request's answer, or its refusal: `error` tells which. */
export type SettledAuthRequest<T> = { data: T; error: null } | { error: SupatypeError }

/**
 * A form's one auth request: the client's answer, or a request that threw as its refusal.
 *
 * Some faults are thrown rather than answered: a client with no API address or anon key throws
 * from its first request. Each form shows `error` whichever way it came, so a throw is shown in the
 * form and reported once with `console.error` instead of escaping a press handler unhandled.
 */
export async function settleAuthRequest<T>(
  form: string,
  send: () => Promise<{ data: T; error: SupatypeError | null }>,
): Promise<SettledAuthRequest<T>> {
  try {
    const { data, error } = await send()
    return error === null ? { data, error } : { error }
  } catch (e) {
    return { error: reportThrown(form, e) }
  }
}
