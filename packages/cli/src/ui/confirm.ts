import { isInteractive } from "./interactive.js"
import { CLACK_CANCEL, isCancel, p } from "./clack.js"
import { plain } from "./messages.js"

export interface ConfirmOptions {
  default?: boolean
  /** When non-interactive, return this instead of `default` (e.g. require --yes). */
  nonInteractive?: boolean
}

/**
 * Yes/no confirmation: Ink overlay in dev, Ink flow in TTY, default otherwise.
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

/** What a person said to a change only they may approve. */
export type Consent = "given" | "declined" | "needs-yes"

/**
 * Ask before a change only a person may approve. `--yes` is consent; without it a run that cannot
 * ask has none, which the caller reports as an error (`needs-yes`) rather than reading silence as a
 * no and exiting 0, so a pipeline that forgot `--yes` fails instead of passing having done nothing.
 */
export async function askConsent(question: string, yes: boolean): Promise<Consent> {
  if (yes) return "given"
  if (!isInteractive()) return "needs-yes"
  return (await confirm(question, { default: false })) ? "given" : "declined"
}

/** Legacy-style y/N prompt text for non-TTY logs when skipping confirm. */
export function logSkippedConfirm(reason: string): void {
  plain(`${reason} (use --yes to skip confirmation)`)
}

export { isCancel, CLACK_CANCEL } from "./clack.js"
