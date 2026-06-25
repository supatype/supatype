import * as p from "@clack/prompts"
import { SUPATYPE_ASCII_LOGO_WORDMARK, colorLogoLines } from "../dev-logo.js"
import { plain } from "./messages.js"
import { isInteractive } from "./interactive.js"

/** Print the coloured Supatype ASCII wordmark at the top of an interactive command. */
export function printLogo(): void {
  plain()
  plain(colorLogoLines([...SUPATYPE_ASCII_LOGO_WORDMARK]).join("\n"))
  plain()
}

/**
 * Unwrap a clack prompt result, exiting cleanly when the user cancels (Ctrl-C).
 */
export function ensureNotCancelled<T>(value: T | symbol, cancelMessage = "Cancelled."): T {
  if (p.isCancel(value)) {
    p.cancel(cancelMessage)
    process.exit(0)
  }
  return value as T
}

/** Single-line text input via Clack (TTY only). */
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

export { p as clack }
