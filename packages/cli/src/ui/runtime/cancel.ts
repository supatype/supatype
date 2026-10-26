/** Clack-compatible cancel sentinel for Ink prompt flows. */
export const CLACK_CANCEL = Symbol("supatype:cancel")

export function isCancel(value: unknown): value is typeof CLACK_CANCEL {
  return value === CLACK_CANCEL
}

/**
 * A prompt's answer when it is the kind the prompt asks for, otherwise the cancel sentinel. A prompt
 * view hands back `unknown` (an answer, or CLACK_CANCEL on Esc), so each prompt says what it accepts.
 */
export function promptAnswer<T>(
  value: unknown,
  accepts: (value: unknown) => value is T,
): T | typeof CLACK_CANCEL {
  return accepts(value) ? value : CLACK_CANCEL
}
