import { colorLogoLines, SUPATYPE_ASCII_LOGO_WORDMARK } from "../dev-logo.js"
import { isInteractive } from "./interactive.js"
import { plain } from "./messages.js"
import { CLACK_CANCEL, isCancel, p } from "./clack.js"

/** Print the coloured Supatype ASCII wordmark at the top of an interactive command. */
export function printLogo(): void {
  plain()
  plain(colorLogoLines([...SUPATYPE_ASCII_LOGO_WORDMARK]).join("\n"))
  plain()
}

/**
 * Unwrap a prompt result, exiting cleanly when the user cancels (Ctrl-C).
 */
export function ensureNotCancelled<T>(value: T | typeof CLACK_CANCEL, cancelMessage = "Cancelled."): T {
  if (isCancel(value)) {
    p.cancel(cancelMessage)
  }
  return value as T
}

/** Single-line text input (TTY only). */
export async function promptText(
  message: string,
  opts?: { defaultValue?: string; placeholder?: string },
): Promise<string> {
  if (!isInteractive()) {
    throw new Error(`Cannot prompt for "${message}" in non-interactive mode.`)
  }
  const value = await p.text({
    message,
    ...(opts?.defaultValue !== undefined ? { defaultValue: opts.defaultValue } : {}),
    ...(opts?.placeholder !== undefined ? { placeholder: opts.placeholder } : {}),
  })
  return ensureNotCancelled(value).trim()
}

/** Masked password input (TTY only). */
export async function promptPassword(message: string): Promise<string> {
  if (!isInteractive()) {
    throw new Error(`Cannot prompt for "${message}" in non-interactive mode.`)
  }
  const value = await p.password({ message })
  return ensureNotCancelled(value).trim()
}

export { p, clack, isCancel, CLACK_CANCEL, runClackFlow } from "./clack.js"
