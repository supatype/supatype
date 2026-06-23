import * as p from "@clack/prompts"
import { SUPATYPE_ASCII_LOGO_WORDMARK, colorLogoLines } from "./dev-logo.js"

/** Print the coloured Supatype ASCII wordmark at the top of an interactive command. */
export function printLogo(): void {
  console.log()
  console.log(colorLogoLines([...SUPATYPE_ASCII_LOGO_WORDMARK]).join("\n"))
  console.log()
}

/**
 * Unwrap a clack prompt result, exiting cleanly when the user cancels (Ctrl-C).
 * Shared by all interactive commands so cancellation behaves consistently.
 */
export function ensureNotCancelled<T>(value: T | symbol, cancelMessage = "Cancelled."): T {
  if (p.isCancel(value)) {
    p.cancel(cancelMessage)
    process.exit(0)
  }
  return value as T
}
