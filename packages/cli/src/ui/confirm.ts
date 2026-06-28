import { isInteractive } from "./interactive.js"
import { CLACK_CANCEL, isCancel, p } from "./clack.js"
import { plain } from "./messages.js"

export interface ConfirmOptions {
  default?: boolean
  /** When non-interactive, return this instead of `default` (e.g. require --yes). */
  nonInteractive?: boolean
}

/**
 * Yes/no confirmation — Ink overlay in dev, Ink flow in TTY, default otherwise.
 */
export async function confirm(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const fallback = opts.nonInteractive ?? opts.default ?? false

  if (!isInteractive()) {
    if (opts.nonInteractive !== undefined) return opts.nonInteractive
    return fallback
  }

  const value = await p.confirm({
    message,
    initialValue: opts.default ?? false,
  })

  if (isCancel(value)) {
    p.cancel("Cancelled.")
  }

  return value
}

/** Legacy-style y/N prompt text for non-TTY logs when skipping confirm. */
export function logSkippedConfirm(reason: string): void {
  plain(`${reason} (use --yes to skip confirmation)`)
}

export { isCancel, CLACK_CANCEL } from "./clack.js"
