/** Clack-compatible cancel sentinel for Ink prompt flows. */
export const CLACK_CANCEL = Symbol("supatype:cancel")

export function isCancel(value: unknown): value is typeof CLACK_CANCEL {
  return value === CLACK_CANCEL
}
